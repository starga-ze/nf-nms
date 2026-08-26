#pragma once

#include "grpc/GrpcProtocol.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace pz::mgmtd

{

// One outbound call to pretzel-ai.
//
// Unlike IpcMessage this carries no header and no serialized payload: nothing here crosses a
// socket in this form. It is the in-process envelope that lets MgmtdTxRouter forward a call
// without knowing which call it is — the fields are named rather than opaque because there are
// two shapes, not twenty, and a byte buffer would cost a serialize/parse pair to hide nothing.
struct GrpcMessage
{
    GrpcCmd cmd{GrpcCmd::Unknown};

    // The ticket the browser polls. Unused by streaming calls, which report into a live slot
    // instead of resolving a ticket.
    std::uint32_t ticket{0};

    // Chat.
    std::string model;
    std::string systemPrompt;

    // Chat: the person's turn. Corpus: the product scope, empty for the whole sitemap.
    std::string message;

    // CorpusDocuments only: which book's documents to list.
    std::string docset;

    // Chat: one earlier turn of the same conversation, as (role, content).
    struct Turn
    {
        std::string role;
        std::string content;
    };

    // Chat: the turns before this one, oldest first, excluding `message`. Carried rather than
    // remembered — mgmtd holds no conversation of its own; the browser owns the thread and sends
    // what the model should see.
    std::vector<Turn> history;

    // Chat: the conversation id, forwarded all the way to Prisma AIRS as the scan's tr_id so a
    // thread reads as one session there instead of one session per turn.
    std::string sessionId;

    // Chat: one operator request, minted here when the turn arrives. It outlives the individual
    // model calls pretzel-ai makes to satisfy it — with tool calls that is several — which is why
    // it is separate from the per-call id pretzel-ai issues on its own side.
    std::string transactionId;

    static GrpcMessage chat(std::uint32_t ticket, std::string model, std::string message,
                           std::string systemPrompt, std::vector<Turn> history = {},
                           std::string sessionId = {}, std::string transactionId = {})
    {
        GrpcMessage out;
        out.cmd = GrpcCmd::Chat;
        out.ticket = ticket;
        out.model = std::move(model);
        out.message = std::move(message);
        out.systemPrompt = std::move(systemPrompt);
        out.history = std::move(history);
        out.sessionId = std::move(sessionId);
        out.transactionId = std::move(transactionId);
        return out;
    }

    // Benchtest. `datasetId` names the set; the rest are the upload's file and the listing's
    // filters. Kept as named fields for the reason the chat ones are: there are a few of them,
    // not twenty, and an opaque buffer would cost a serialize/parse pair to hide nothing.
    std::int64_t datasetId{0};
    std::string content;      // BenchtestUpload: the whole .jsonl
    std::string filename;
    std::string name;
    std::string note;
    std::string uploadedBy;
    std::string category;
    std::string verdict;
    std::string language;
    std::string technique;
    std::string search;
    std::int32_t offset{0};
    std::int32_t limit{0};
    std::string orderBy;
    bool descending{false};

    // Benchtest runs. `datasetId` and the filter fields above define a run's scope; `runId`/`seq`
    // address one that already happened.
    std::int64_t runId{0};
    std::int32_t seq{0};
    std::int32_t workers{0};
    std::string cause;

    static GrpcMessage benchtestRun(std::uint32_t ticket, std::int64_t datasetId,
                                    std::string category, std::string verdict,
                                    std::string language, std::string technique,
                                    std::string search, std::int32_t workers, std::string label,
                                    std::string note)
    {
        GrpcMessage out;
        out.cmd = GrpcCmd::BenchtestRun;
        out.ticket = ticket;
        out.datasetId = datasetId;
        out.category = std::move(category);
        out.verdict = std::move(verdict);
        out.language = std::move(language);
        out.technique = std::move(technique);
        out.search = std::move(search);
        out.workers = workers;
        out.name = std::move(label);
        out.note = std::move(note);
        return out;
    }

    static GrpcMessage benchtestRunRead(GrpcCmd cmd, std::uint32_t ticket, std::int64_t runId,
                                        std::int64_t datasetId = 0, std::string cause = {},
                                        std::int32_t seq = 0, std::int32_t offset = 0,
                                        std::int32_t limit = 0)
    {
        GrpcMessage out;
        out.cmd = cmd;
        out.ticket = ticket;
        out.runId = runId;
        out.datasetId = datasetId;
        out.cause = std::move(cause);
        out.seq = seq;
        out.offset = offset;
        out.limit = limit;
        return out;
    }

    static GrpcMessage benchtestUpload(std::uint32_t ticket, std::string content,
                                       std::string filename, std::string name,
                                       std::string note, std::string uploadedBy)
    {
        GrpcMessage out;
        out.cmd = GrpcCmd::BenchtestUpload;
        out.ticket = ticket;
        out.content = std::move(content);
        out.filename = std::move(filename);
        out.name = std::move(name);
        out.note = std::move(note);
        out.uploadedBy = std::move(uploadedBy);
        return out;
    }

    // Datasets / Delete / Summary / Export — everything whose whole input is an id (or, for the
    // listing, a search string).
    static GrpcMessage benchtest(GrpcCmd cmd, std::uint32_t ticket, std::int64_t datasetId = 0,
                                 std::string search = {})
    {
        GrpcMessage out;
        out.cmd = cmd;
        out.ticket = ticket;
        out.datasetId = datasetId;
        out.search = std::move(search);
        return out;
    }

    static GrpcMessage benchtestRows(std::uint32_t ticket, std::int64_t datasetId,
                                     std::string category, std::string verdict,
                                     std::string language, std::string technique,
                                     std::string search, std::int32_t offset, std::int32_t limit,
                                     std::string orderBy, bool descending)
    {
        GrpcMessage out;
        out.cmd = GrpcCmd::BenchtestRows;
        out.ticket = ticket;
        out.datasetId = datasetId;
        out.category = std::move(category);
        out.verdict = std::move(verdict);
        out.language = std::move(language);
        out.technique = std::move(technique);
        out.search = std::move(search);
        out.offset = offset;
        out.limit = limit;
        out.orderBy = std::move(orderBy);
        out.descending = descending;
        return out;
    }

    // ListModels — the whole input is the ticket, so there is nothing to carry but the cmd.
    static GrpcMessage models(std::uint32_t ticket)
    {
        GrpcMessage out;
        out.cmd = GrpcCmd::ListModels;
        out.ticket = ticket;
        return out;
    }

    static GrpcMessage corpus(GrpcCmd cmd, std::uint32_t ticket, std::string scope = {},
                              std::string docset = {})
    {
        GrpcMessage out;
        out.cmd = cmd;
        out.ticket = ticket;
        out.message = std::move(scope);
        out.docset = std::move(docset);
        return out;
    }
};

}
