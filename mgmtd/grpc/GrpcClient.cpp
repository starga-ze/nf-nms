#include "grpc/GrpcClient.h"

#include <grpcpp/grpcpp.h>
#include <google/protobuf/util/json_util.h>

#include "pretzel_ai.grpc.pb.h"

#include "util/Logger.h"

#include <chrono>
#include <mutex>
#include <string>

namespace pz::mgmtd
{

namespace v1 = ::pretzel::ai::v1;

struct GrpcClient::Impl
{
    std::shared_ptr<grpc::Channel> channel;
    std::unique_ptr<v1::PretzelAi::Stub> stub;

    // The in-flight stream's context, so another thread can cancel it. Guarded because the
    // cancelling thread and the streaming thread are different by definition.
    //
    // These point at a ClientContext on the streaming thread's STACK, which is why clearing them
    // is not optional and not something to do on the way past the last line: an exception between
    // the two would leave a pointer into a dead frame, and the next cancel would TryCancel through
    // it. Use the guard below rather than a pair of assignments — one of these two call sites was
    // written each way, and the one written by hand was the one that could dangle.
    std::mutex refreshMutex;
    grpc::ClientContext* activeRefresh = nullptr;
    grpc::ClientContext* activeRun = nullptr;

    // Publishes `ctx` for the cancelling thread, and withdraws it however the caller leaves.
    class ActiveStream
    {
    public:
        ActiveStream(Impl& impl, grpc::ClientContext*& slot, grpc::ClientContext& ctx)
            : m_impl(impl), m_slot(slot)
        {
            std::lock_guard<std::mutex> lock(m_impl.refreshMutex);
            m_slot = &ctx;
        }
        ~ActiveStream()
        {
            std::lock_guard<std::mutex> lock(m_impl.refreshMutex);
            m_slot = nullptr;
        }
        ActiveStream(const ActiveStream&) = delete;
        ActiveStream& operator=(const ActiveStream&) = delete;

    private:
        Impl& m_impl;
        grpc::ClientContext*& m_slot;
    };
};

GrpcClient::GrpcClient(const std::string& target)
    : m_impl(std::make_unique<Impl>())
{
    // A benchtest upload carries a whole .jsonl in one message, which is past gRPC's 4 MB
    // default. Raised on both directions to match what pretzel-ai's store accepts (32 MB) plus
    // framing: without this the large-file case fails at the transport with RESOURCE_EXHAUSTED
    // and never reaches the server's own size check, whose message actually says what to do.
    constexpr int kMaxMessageBytes = 33 * 1024 * 1024;
    grpc::ChannelArguments args;
    args.SetMaxReceiveMessageSize(kMaxMessageBytes);
    args.SetMaxSendMessageSize(kMaxMessageBytes);

    m_impl->channel = grpc::CreateCustomChannel(target, grpc::InsecureChannelCredentials(), args);
    m_impl->stub = v1::PretzelAi::NewStub(m_impl->channel);
}

GrpcClient::~GrpcClient() = default;

namespace
{
// The ChatRequest exactly as it goes on the wire, for lining this end up with what pretzel-ai
// logs on receipt. Every field appears, including the empty ones — an absent line and an empty
// value are different facts, and the whole reason to read this dump is to find out which one you
// have.
//
// DEBUG on purpose, and it must stay there: `message` and `history` are whatever a person typed,
// and the INFO log deliberately reports only their sizes. Turning this on is a decision to read
// employee text, so it should take a decision.
std::string dumpChatRequest(const v1::ChatRequest& r)
{
    // Values are capped; fields are not. A 32 KiB turn would otherwise bury the surrounding log,
    // and the cut is marked so nobody reads a truncated value as the whole of it.
    constexpr std::size_t kCap = 2048;
    auto val = [](const std::string& v)
    {
        if (v.empty())
            return std::string("\"\" (empty)");
        // Bytes, and labelled as such: std::string::size() counts them, and pretzel-ai's dump
        // sizes the same way so the two blocks line up on a Korean turn as well as an ASCII one.
        std::string out = "(" + std::to_string(v.size()) + " bytes) \"";
        out += v.size() > kCap ? v.substr(0, kCap) + "\" …truncated" : v + "\"";
        return out;
    };

    std::string d = "\n"
         "  ┌─ ChatRequest → pretzel-ai ─────────────────────────────────────────\n";
    d += "  │ model           " + val(r.model())          + "\n";
    d += "  │ message         " + val(r.message())        + "\n";
    d += "  │ system_prompt   " + val(r.system_prompt())  + "\n";
    d += "  │ session_id      " + val(r.session_id())     + "\n";
    d += "  │ transaction_id  " + val(r.transaction_id()) + "\n";
    d += "  │ history         " + std::to_string(r.history_size()) + " turn(s)\n";
    d += "  └────────────────────────────────────────────────────────────────────\n";
    return d;
}
}  // namespace

GrpcClient::Outcome GrpcClient::chat(const std::string& model,
                                              const std::string& message,
                                              const std::string& systemPrompt,
                                              const std::vector<GrpcMessage::Turn>& history,
                                              const std::string& sessionId,
                                              const std::string& transactionId,
                                              const std::function<void(const std::string&)>& on_delta)
{
    v1::ChatRequest request;
    request.set_model(model);
    request.set_message(message);
    request.set_system_prompt(systemPrompt);
    request.set_session_id(sessionId);
    request.set_transaction_id(transactionId);

    // Oldest first, and `message` is not among them: the server appends this turn after the ones
    // sent here, so including it would ask the question twice.
    for (const auto& turn : history)
    {
        v1::ChatTurn* out = request.add_history();
        out->set_role(turn.role);
        out->set_content(turn.content);
    }

    LOG_TRACE("{}", dumpChatRequest(request));

    grpc::ClientContext ctx;
    std::unique_ptr<grpc::ClientReader<v1::ChatChunk>> reader(
        m_impl->stub->Chat(&ctx, request));

    // The final chunk (done=true) carries the complete turn document and, on a failed turn, the
    // reason. A transport failure (reader->Finish() not ok) is distinct — the stream may never
    // reach that final chunk — and is reported on its own.
    Outcome out;
    v1::ChatChunk chunk;
    while (reader->Read(&chunk))
    {
        if (!chunk.delta().empty())
            on_delta(chunk.delta());
        if (chunk.done())
        {
            if (!chunk.error().empty())
                out.error = chunk.error();
            if (!chunk.result_json().empty())
                out.resultJson = chunk.result_json();
        }
    }

    const grpc::Status status = reader->Finish();
    if (!status.ok())
        out.error = "gRPC transport error: " + status.error_message();

    return out;
}

namespace
{

// Proto -> JSON for the console. always_print_primitive_fields matters: a count that has fallen
// back to zero must still appear, or the card would render "—" where the answer is "none".
std::string toJson(const google::protobuf::Message& message)
{
    google::protobuf::util::JsonPrintOptions options;
    options.always_print_primitive_fields = true;
    options.preserve_proto_field_names = true;
    std::string out;
    if (!google::protobuf::util::MessageToJsonString(message, &out, options).ok())
        return "{}";
    return out;
}

}

std::string GrpcClient::applyConfig(const std::string& configJson, std::string& error)
{
    v1::ApplyConfigRequest request;
    google::protobuf::util::JsonParseOptions parseOptions;
    // A field the running config carries and this proto does not is not a reason to refuse the
    // push: the rest of the document is still what the service should be running, and the
    // alternative — dropping the whole deployment over one unknown key — is how a config schema
    // change turns into an assistant that stops answering.
    parseOptions.ignore_unknown_fields = true;
    const auto parsed = google::protobuf::util::JsonStringToMessage(configJson, &request, parseOptions);
    if (!parsed.ok())
    {
        error = "the assembled config is not valid for ApplyConfig: " + std::string(parsed.message());
        return {};
    }

    grpc::ClientContext ctx;
    v1::ApplyConfigResult reply;
    const grpc::Status status = m_impl->stub->ApplyConfig(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    if (!reply.ok())
        error = reply.error().empty() ? "the service refused the configuration" : reply.error();
    return toJson(reply);
}

std::string GrpcClient::listModels(std::string& error)
{
    grpc::ClientContext ctx;
    v1::ListModelsRequest request;
    v1::ModelList reply;
    const grpc::Status status = m_impl->stub->ListModels(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    if (!reply.error().empty())
        error = reply.error();
    return toJson(reply);
}

std::string GrpcClient::corpusStatus(std::string& error)
{
    grpc::ClientContext ctx;
    v1::CorpusStatusRequest request;
    v1::CorpusStatus reply;
    const grpc::Status status = m_impl->stub->GetCorpusStatus(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    if (!reply.error().empty())
        error = reply.error();
    return toJson(reply);
}

std::string GrpcClient::corpusDocuments(const std::string& product, const std::string& docset,
                                        std::string& error)
{
    v1::ListDocumentsRequest request;
    request.set_product(product);
    request.set_docset(docset);

    grpc::ClientContext ctx;
    v1::DocumentList reply;
    const grpc::Status status = m_impl->stub->ListDocuments(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    if (!reply.error().empty())
        error = reply.error();
    return toJson(reply);
}

// --- Benchtest sets -------------------------------------------------------------------------
//
// An upload carries a whole file in one message. The channel is created with a raised message
// limit (see the constructor) because the default 4 MB sits below what the store accepts, and a
// file over that would fail at the transport with a RESOURCE_EXHAUSTED that never reaches the
// server's own size check and its clearer message.

std::string GrpcClient::benchtestDatasets(const std::string& search, std::string& error)
{
    v1::ListBenchmarkDatasetsRequest request;
    request.set_search(search);

    grpc::ClientContext ctx;
    v1::BenchmarkDatasetList reply;
    const grpc::Status status = m_impl->stub->ListBenchmarkDatasets(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

std::string GrpcClient::benchtestSummary(std::int64_t datasetId, std::string& error)
{
    v1::BenchmarkSummaryRequest request;
    request.set_dataset_id(datasetId);

    grpc::ClientContext ctx;
    v1::BenchmarkSummary reply;
    const grpc::Status status = m_impl->stub->GetBenchmarkSummary(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

std::string GrpcClient::benchtestRows(std::int64_t datasetId, const std::string& category,
                                      const std::string& verdict, const std::string& language,
                                      const std::string& technique, const std::string& checkpoint,
                                      const std::string& search,
                                      std::int32_t offset, std::int32_t limit,
                                      const std::string& orderBy, bool descending,
                                      std::string& error)
{
    v1::ListBenchmarkRequest request;
    request.set_dataset_id(datasetId);
    request.set_category(category);
    request.set_verdict(verdict);
    request.set_language(language);
    request.set_technique(technique);
    request.set_checkpoint(checkpoint);
    request.set_search(search);
    request.set_offset(offset);
    request.set_limit(limit);
    request.set_order_by(orderBy);
    request.set_descending(descending);

    grpc::ClientContext ctx;
    v1::BenchmarkPage reply;
    const grpc::Status status = m_impl->stub->ListBenchmark(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

std::string GrpcClient::benchtestUpload(const std::string& content, const std::string& filename,
                                        const std::string& name, const std::string& note,
                                        const std::string& uploadedBy, std::string& error)
{
    v1::UploadBenchmarkDatasetRequest request;
    request.set_content(content);
    request.set_filename(filename);
    request.set_name(name);
    request.set_note(note);
    request.set_uploaded_by(uploadedBy);

    grpc::ClientContext ctx;
    v1::UploadBenchmarkDatasetResult reply;
    const grpc::Status status = m_impl->stub->UploadBenchmarkDataset(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

std::string GrpcClient::benchtestDelete(std::int64_t datasetId, std::string& error)
{
    v1::DeleteBenchmarkDatasetRequest request;
    request.set_dataset_id(datasetId);

    grpc::ClientContext ctx;
    v1::DeleteBenchmarkDatasetResult reply;
    const grpc::Status status = m_impl->stub->DeleteBenchmarkDataset(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

GrpcClient::Export GrpcClient::benchtestExport(std::int64_t datasetId)
{
    v1::ExportBenchmarkDatasetRequest request;
    request.set_dataset_id(datasetId);

    grpc::ClientContext ctx;
    v1::ExportBenchmarkDatasetResult reply;
    const grpc::Status status = m_impl->stub->ExportBenchmarkDataset(&ctx, request, &reply);

    Export out;
    if (!status.ok())
    {
        out.error = "gRPC transport error: " + status.error_message();
        return out;
    }
    out.error = reply.error();
    out.content = reply.content();
    out.filename = reply.filename();
    return out;
}

void GrpcClient::benchtestRun(std::int64_t datasetId, const std::string& category,
                              const std::string& verdict, const std::string& language,
                              const std::string& technique, const std::string& search,
                              std::int32_t workers, const std::string& label,
                              const std::string& note,
                              const std::function<void(const std::string&)>& on_progress,
                              std::string& error)
{
    v1::RunBenchtestRequest request;
    request.set_dataset_id(datasetId);
    request.set_category(category);
    request.set_verdict(verdict);
    request.set_language(language);
    request.set_technique(technique);
    request.set_search(search);
    request.set_workers(workers);
    request.set_label(label);
    request.set_note(note);

    grpc::ClientContext ctx;
    Impl::ActiveStream active(*m_impl, m_impl->activeRun, ctx);

    std::unique_ptr<grpc::ClientReader<v1::RunProgress>> reader(
        m_impl->stub->RunBenchtest(&ctx, request));
    v1::RunProgress progress;
    while (reader->Read(&progress))
        on_progress(toJson(progress));

    const grpc::Status status = reader->Finish();
    if (!status.ok() && status.error_code() != grpc::StatusCode::CANCELLED)
        error = "gRPC transport error: " + status.error_message();
}

void GrpcClient::cancelBenchtestRun()
{
    std::lock_guard<std::mutex> lock(m_impl->refreshMutex);
    if (m_impl->activeRun)
        m_impl->activeRun->TryCancel();
}

std::string GrpcClient::benchtestRuns(std::int64_t datasetId, std::int32_t limit,
                                      std::string& error)
{
    v1::ListBenchtestRunsRequest request;
    request.set_dataset_id(datasetId);
    request.set_limit(limit);

    grpc::ClientContext ctx;
    v1::BenchtestRunList reply;
    const grpc::Status status = m_impl->stub->ListBenchtestRuns(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

std::string GrpcClient::benchtestRunInfo(std::int64_t runId, const std::string& category,
                                         const std::string& verdict, const std::string& language,
                                         const std::string& technique,
                                         const std::string& checkpoint,
                                         const std::string& search,
                                         std::string& error)
{
    v1::GetBenchtestRunRequest request;
    request.set_run_id(runId);
    request.set_category(category);
    request.set_verdict(verdict);
    request.set_language(language);
    request.set_technique(technique);
    request.set_checkpoint(checkpoint);
    request.set_search(search);

    grpc::ClientContext ctx;
    v1::BenchtestRunSummary reply;
    const grpc::Status status = m_impl->stub->GetBenchtestRun(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

std::string GrpcClient::benchtestCases(std::int64_t runId, const std::string& cause,
                                       const std::string& category, const std::string& verdict,
                                       const std::string& language, const std::string& technique,
                                       const std::string& checkpoint,
                                       const std::string& search, const std::string& orderBy,
                                       bool descending,
                                       std::int32_t offset, std::int32_t limit,
                                       std::string& error)
{
    v1::ListBenchtestCasesRequest request;
    request.set_run_id(runId);
    request.set_cause(cause);
    request.set_category(category);
    request.set_verdict(verdict);
    request.set_language(language);
    request.set_technique(technique);
    request.set_checkpoint(checkpoint);
    request.set_search(search);
    request.set_order_by(orderBy);
    request.set_descending(descending);
    request.set_offset(offset);
    request.set_limit(limit);

    grpc::ClientContext ctx;
    v1::BenchtestCaseList reply;
    const grpc::Status status = m_impl->stub->ListBenchtestCases(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

std::string GrpcClient::benchtestCase(std::int64_t runId, std::int32_t seq, std::string& error)
{
    v1::GetBenchtestCaseRequest request;
    request.set_run_id(runId);
    request.set_seq(seq);

    grpc::ClientContext ctx;
    v1::BenchtestCaseDetail reply;
    const grpc::Status status = m_impl->stub->GetBenchtestCase(&ctx, request, &reply);
    if (!status.ok())
    {
        error = "gRPC transport error: " + status.error_message();
        return {};
    }
    return toJson(reply);
}

void GrpcClient::refreshCorpus(const std::string& scope,
                               const std::function<void(const std::string&)>& on_progress,
                               std::string& error)
{
    v1::RefreshCorpusRequest request;
    request.set_scope(scope);

    grpc::ClientContext ctx;
    Impl::ActiveStream active(*m_impl, m_impl->activeRefresh, ctx);

    std::unique_ptr<grpc::ClientReader<v1::RefreshProgress>> reader(
        m_impl->stub->RefreshCorpus(&ctx, request));

    v1::RefreshProgress progress;
    while (reader->Read(&progress))
    {
        on_progress(toJson(progress));
        if (progress.final() && !progress.error().empty())
            error = progress.error();
    }

    const grpc::Status status = reader->Finish();
    if (!status.ok() && error.empty())
        error = "gRPC transport error: " + status.error_message();
}

void GrpcClient::cancelRefresh()
{
    std::lock_guard<std::mutex> lock(m_impl->refreshMutex);
    if (m_impl->activeRefresh)
        m_impl->activeRefresh->TryCancel();
}

int GrpcClient::connectivityState(bool tryToConnect)
{
    return static_cast<int>(m_impl->channel->GetState(tryToConnect));
}

bool GrpcClient::waitForStateChange(int lastState, int timeoutMs)
{
    const auto deadline = std::chrono::system_clock::now() + std::chrono::milliseconds(timeoutMs);
    return m_impl->channel->WaitForStateChange(
        static_cast<grpc_connectivity_state>(lastState), deadline);
}

}
