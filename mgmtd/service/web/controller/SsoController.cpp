#include "service/web/controller/SsoController.h"

#include "service/MgmtdServiceManager.h"

#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"

#include "config/Config.h"
#include "http/HttpMessage.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <memory>
#include <random>
#include <string>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

std::string ssoRandomHex(std::size_t nBytes)
{
    static const char* hex = "0123456789abcdef";
    std::random_device rd;
    std::mt19937_64 gen(rd());
    std::uniform_int_distribution<int> dist(0, 15);
    std::string s;
    s.reserve(nBytes * 2);
    for (std::size_t i = 0; i < nBytes * 2; ++i)
        s.push_back(hex[dist(gen)]);
    return s;
}

std::string ssoUtcNow()
{
    std::time_t t = std::time(nullptr);
    std::tm tm{};
    gmtime_r(&t, &tm);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

std::string ssoBase64(const std::string& in)
{
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((in.size() + 2) / 3 * 4);
    const auto* d = reinterpret_cast<const unsigned char*>(in.data());
    std::size_t len = in.size(), i = 0;
    for (; i + 2 < len; i += 3)
    {
        std::uint32_t n = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        out.push_back(tbl[(n >> 18) & 63]);
        out.push_back(tbl[(n >> 12) & 63]);
        out.push_back(tbl[(n >> 6) & 63]);
        out.push_back(tbl[n & 63]);
    }
    if (i < len)
    {
        std::uint32_t n = d[i] << 16;
        if (i + 1 < len)
            n |= d[i + 1] << 8;
        out.push_back(tbl[(n >> 18) & 63]);
        out.push_back(tbl[(n >> 12) & 63]);
        out.push_back((i + 1 < len) ? tbl[(n >> 6) & 63] : '=');
        out.push_back('=');
    }
    return out;
}

std::string ssoUrlDecode(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (std::size_t i = 0; i < s.size(); ++i)
    {
        char c = s[i];
        if (c == '+')
        {
            out.push_back(' ');
        }
        else if (c == '%' && i + 2 < s.size())
        {
            auto hexv = [](char h) -> int
            {
                if (h >= '0' && h <= '9')
                    return h - '0';
                if (h >= 'a' && h <= 'f')
                    return h - 'a' + 10;
                if (h >= 'A' && h <= 'F')
                    return h - 'A' + 10;
                return -1;
            };
            int hi = hexv(s[i + 1]), lo = hexv(s[i + 2]);
            if (hi >= 0 && lo >= 0)
            {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
            }
            else
                out.push_back(c);
        }
        else
            out.push_back(c);
    }
    return out;
}

std::string ssoFormField(const std::string& body, const std::string& key)
{
    const std::string pfx = key + "=";
    std::size_t pos = 0;
    while (pos < body.size())
    {
        std::size_t amp = body.find('&', pos);
        std::string pair = body.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (pair.rfind(pfx, 0) == 0)
            return ssoUrlDecode(pair.substr(pfx.size()));
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return {};
}

std::string ssoHtmlAttr(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (char c : s)
    {
        switch (c)
        {
        case '&':
            out += "&amp;";
            break;
        case '"':
            out += "&quot;";
            break;
        case '<':
            out += "&lt;";
            break;
        case '>':
            out += "&gt;";
            break;
        default:
            out.push_back(c);
        }
    }
    return out;
}

const nlohmann::json& ssoAuthConfig()
{
    return pz::config::Config::section(pz::config::scope::kPretzel, "auth");
}

}

void SsoController::info(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)req;
    const auto auth = ssoAuthConfig();
    const std::string method = auth.value("method", std::string("oidc"));
    bool enabled = false;
    if (method == "saml")
        enabled = auth.value("saml", json::object()).value("enabled", false);
    else
        enabled = auth.value("oidc", json::object()).value("enabled", false);

    const bool adminSetup = !sm.authService().mustChangePassword();
    enabled = enabled && adminSetup;

    const json out = {{"enabled", enabled},
                      {"method", method},
                      {"label", "Sign in with Okta"},
                      {"admin_setup_required", !adminSetup}};
    fill(resp, 200, out.dump());
}

void SsoController::login(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)req;
    auto redirectErr = [&](const std::string& code)
    {
        fill(resp, 302, "", "text/plain");
        resp.location = "/index.html?sso_error=" + code;
    };

    if (sm.authService().mustChangePassword())
        return redirectErr("setup_required");

    const auto auth = ssoAuthConfig();
    if (auth.value("method", std::string("oidc")) != "saml")
        return redirectErr("not_configured");

    const auto saml = auth.value("saml", json::object());
    if (!saml.value("enabled", false))
        return redirectErr("disabled");

    const std::string idp = saml.value("idp_sso_url", "");
    const std::string sp = saml.value("sp_entity_id", "");
    const std::string acs = saml.value("acs_url", "");
    if (idp.empty() || acs.empty())
        return redirectErr("misconfigured");

    const std::string id = "_" + ssoRandomHex(16);
    const std::string xml = "<samlp:AuthnRequest xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\""
                            " xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\""
                            " ID=\"" +
                            id + "\" Version=\"2.0\" IssueInstant=\"" + ssoUtcNow() +
                            "\""
                            " Destination=\"" +
                            idp +
                            "\""
                            " ProtocolBinding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST\""
                            " AssertionConsumerServiceURL=\"" +
                            acs +
                            "\">"
                            "<saml:Issuer>" +
                            sp + "</saml:Issuer></samlp:AuthnRequest>";

    const std::string html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Redirecting…</title></head>"
                             "<body onload=\"document.forms[0].submit()\">"
                             "<form method=\"POST\" action=\"" +
                             ssoHtmlAttr(idp) +
                             "\">"
                             "<input type=\"hidden\" name=\"SAMLRequest\" value=\"" +
                             ssoHtmlAttr(ssoBase64(xml)) +
                             "\"/>"
                             "<noscript><button type=\"submit\">Continue to Okta</button></noscript>"
                             "</form></body></html>";

    fill(resp, 200, html, "text/html; charset=utf-8");
}

void SsoController::samlAcs(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    auto redirectErr = [&](const std::string& code)
    {
        fill(resp, 302, "", "text/plain");
        resp.location = "/index.html?sso_error=" + code;
    };

    const std::string samlResponse = ssoFormField(req.body, "SAMLResponse");
    if (samlResponse.empty())
        return redirectErr("no_saml_response");

    const std::uint32_t ticket = sm.nextSsoTicket();
    const json payload = {{"saml_response", samlResponse}};
    const std::string ps = payload.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
    msg->setDst(pz::ipc::IpcDaemon::Authd);
    msg->setCmd(pz::ipc::IpcCmd::AuthSamlAcsRequest);
    msg->setSeqNo(ticket);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(ps.begin(), ps.end()));
    sm.txRouter().handleIpcMessage(std::move(msg));

    const std::string t = std::to_string(ticket);
    const std::string html =
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Signing in…</title></head>"
        "<body><p style=\"font-family:sans-serif\">Signing in…</p><script>"
        "(function(){var t=" +
        t +
        ",n=0;"
        "function go(){n++;if(n>40){location.href='/index.html?sso_error=timeout';return;}"
        "fetch('/api/auth/saml/result?ticket='+t).then(function(r){return r.json();})"
        ".then(function(d){"
        "if(d.status==='ok'){location.href=d.redirect||'/home.html';}"
        "else if(d.status==='error'){location.href='/index.html?sso_error='+encodeURIComponent(d.error||'failed');}"
        "else{setTimeout(go,600);}"
        "}).catch(function(){setTimeout(go,900);});}"
        "go();})();"
        "</script></body></html>";

    fill(resp, 200, html, "text/html; charset=utf-8");
}

void SsoController::samlResult(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    auto jsonResp = [&](const json& j) { fill(resp, 200, j.dump()); };

    const std::string& target = req.target;
    std::uint32_t ticket = 0;
    if (auto pos = target.find("ticket="); pos != std::string::npos)
        ticket = static_cast<std::uint32_t>(std::strtoul(target.c_str() + pos + 7, nullptr, 10));

    if (ticket == 0)
        return jsonResp({{"status", "error"}, {"error", "bad ticket"}});

    auto result = sm.takeSsoResult(ticket);
    if (!result)
        return jsonResp({{"status", "pending"}});

    try
    {
        const auto verdict = json::parse(*result);
        if (verdict.value("success", false))
        {
            const std::string user = verdict.value("username", "");
            const std::string sid = sm.authService().createSsoSession(user);
            if (sid.empty())
                return jsonResp({{"status", "error"}, {"error", "session error"}});

            fill(resp, 200, json({{"status", "ok"}, {"redirect", "/home"}}).dump());
            resp.setCookie = "session=" + sid + "; HttpOnly; Path=/; SameSite=Strict";
            LOG_INFO("sso login ok (user={})", user);
            return;
        }
        return jsonResp({{"status", "error"}, {"error", verdict.value("error", std::string("verification failed"))}});
    }
    catch (const std::exception& e)
    {
        LOG_WARN("sso result parse error: {}", e.what());
        return jsonResp({{"status", "error"}, {"error", "bad result"}});
    }
}

}
