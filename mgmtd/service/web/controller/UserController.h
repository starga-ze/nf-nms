#pragma once

namespace pz::http { struct HttpRequest; struct HttpResponse; }

namespace pz::mgmtd
{

class MgmtdServiceManager;

// The local accounts, split the way every other credential on this appliance is split.
//
//   running_config   the declaration — { oid, username } per account. Staged in the console,
//                    published with everything else, versioned and rendered in the review diff.
//   local_users      the secret — password hash, salt, and whether a forced change is pending.
//                    Keyed by the same oid the declaration carries.
//
// A password may never take the commit path. running_config is append-versioned and written out by
// Save-to-file, so a hash committed there would be permanent and readable by every reviewer, and
// changing a password would mint a configuration version — which is the reason this file exists
// rather than the settings endpoint growing a special case.
//
// So the console stages an account's declaration like any other object and its password
// browser-local, exactly as the AI Provider page stages a vendor key: Publish commits the one and
// posts the other here, where it is hashed and handed to engined.
class UserController
{
public:
    // GET /api/user/credentials — per account oid: whether a password is stored, whether a change
    // is forced, when it last changed. Never the hash.
    void credentials(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // POST /api/user/credential — { oid, username, password } to set one,
    // { oid, username, remove: true } to delete the account's row.
    void credentialStore(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);
};

}
