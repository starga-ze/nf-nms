#pragma once

#include "http/HttpMessage.h"

namespace pz::mgmtd
{

class MgmtdServiceManager;

// The AI assistant's vendor API keys — the half of Configuration ▸ AI Assistant that cannot be
// committed. Everything else on that page (which vendors are enabled, their endpoints, their model
// catalogs, how a turn is shaped) is ordinary configuration and travels the settings-commit path;
// a key cannot, because running_config is append-versioned, rendered verbatim in the review diff
// and written out by Save-to-file, so a key written there would be permanent and readable by every
// reviewer.
//
// So it takes the same route a device credential takes: the plaintext crosses the wire once, on the
// way in, is sealed here with /etc/pretzel/credentials.key and handed to engined — the only
// database writer — as ciphertext. It is never read back out to the browser; the console is told
// only whether a key is stored.
//
// Sealed HERE rather than delegated to a worker daemon, which is where the device path differs.
// collectord seals a device credential because collectord is the process that will present it to
// the firewall, so the plaintext lives in exactly one process. The assistant's peer is pretzel-ai,
// which is not on the IPC fabric, so there is no worker to delegate to — mgmtd is already the
// process holding the plaintext and sealing it anywhere else would only add a hop.
class AiController
{
public:
    // GET /api/ai/credentials — per vendor: whether a key is stored, and when it last changed.
    // Never the key itself.
    void credentials(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // POST /api/ai/credential — { id, api_key } to store one, { id, clear: true } to remove it.
    void credentialStore(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);
};

}
