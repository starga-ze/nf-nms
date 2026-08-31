#pragma once

#include "service/apicredential/ApiCredentialEvent.h"

#include <cstdint>
#include <string>

namespace pz::engined
{

class EnginedServiceManager;

// Persists what pretzel learns about a device API key: the issued secret, when it expires, and
// how the last verification went.
//
// None of it belongs in running_config. That document is append-versioned, diffed before publish
// and exported by Save-to-file, so a key written there would be permanent, visible to whoever
// reviews the change, and carried into every backup — while re-issuing one would mint a
// configuration version for something no operator authored. It lands in api_credential_state instead,
// the same reasoning that keeps admin passwords in local_users.
//
// collectord runs the key generation (it is the one talking to the device) but engined is the sole
// database writer, so collectord encrypts the secret and sends it here, exactly as mgmtd does for an
// admin password change.
//
// The way back out is sendState(): collectord asks for the issued keys and gets them back STILL
// SEALED, then opens them with credentials.key. engined never holds a plaintext key and the
// socket never carries one — the same contract as the inbound direction.
class ApiCredentialService
{
public:
    ApiCredentialService() = default;
    ~ApiCredentialService() = default;

    void handleEvent(EnginedServiceManager& serviceManager, const ApiCredentialEvent& event);

private:
    void storeState(const std::string& payloadJson);

    // Stores a validated+sealed SASE device health api-key into sase_device.api_key_enc.
    void storeSaseApiKey(const std::string& payloadJson);

    // Stores a sealed AI provider credential into ai_provider_credential_state. mgmtd seals
    // it and opens it again when a turn needs it; engined only ever sees ciphertext, exactly as it
    // does for a device credential.
    void storeAiCredential(const std::string& payloadJson);

    // Answers ApiCredentialStateRequest with every issued key, sealed, routed back to `requester`
    // (probed or collectord). seqNo is the requester's correlation value and is echoed back.
    void sendState(EnginedServiceManager& serviceManager, pz::ipc::IpcDaemon requester, std::uint32_t seqNo);
};

}
