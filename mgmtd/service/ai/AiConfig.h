#pragma once

#include <string>

namespace pz::mgmtd
{

class MgmtdServiceManager;

// Deliver the assistant's deployment to pretzel-ai.
//
// engined's ConfigApply broadcast reaches every daemon on the IPC fabric. pretzel-ai is not on it —
// it is a separate service reached over gRPC — so the section it owns would otherwise be committed,
// versioned and diffed by an operator who never sees it take effect. This is that broadcast's
// equivalent for the one peer that lives off the bus.
//
// mgmtd is the one who sends it, rather than engined who owns the running config, for a plain
// reason: mgmtd is the only process holding both a gRPC channel to the service and
// /etc/pretzel/credentials.key, and the document has to carry the vendor keys — they are the one
// part that cannot live in running_config. Splitting it (engined pushes the config, mgmtd pushes
// the keys) would give the service two half-configurations arriving in an order nobody controls.
//
// What travels: the providers and their models, the guardrail (which of the four checkpoints
// inspect, and what rules on them), and the turn shape. The guardrail did not use to — it lived in
// pretzel-ai's own config.json on the argument that an appliance changing which models it serves
// must not be able to change whether the turns are inspected. That file is gone. It bought its
// protection by making the guardrail unconfigurable without editing a file on the appliance and
// restarting the service, which is not something an operator can be asked to do; the protection
// now comes from every change being a committed, versioned running_config edit that a reviewer
// sees in the diff.
//
// Three keys' worth of secret, all sealed the same way: one per vendor, plus the scan service's
// under the reserved id "airs". None of them is in running_config — that document is
// append-versioned and rendered verbatim in a review diff.
//
// Sent whenever the appliance has reason to think the service's view is stale:
//   * the fleet's RuntimeStart — a cold boot, and the only push a restarted appliance needs
//   * a settings commit converging — the operator changed the deployment
//   * a key stored or removed — the config did not change, but what it can do did
//
// Fire-and-forget. The call is idempotent and carries the version it was read at, so a lost push
// is repaired by the next one and a duplicate costs nothing; failures belong in the log, because
// nobody is holding a screen open on this.
void pushAiConfig(MgmtdServiceManager& sm, const char* reason);

// The same push, with one vendor's key taken from the caller rather than from the store.
//
// For the one caller that has just accepted a key and cannot read it back yet: engined is the only
// database writer and the message carrying the key is one-way, so at the moment the console's Save
// returns, the table still holds the previous value — or nothing. Reading it here would push the
// key the operator just replaced, and the assistant would keep failing until something else
// triggered a push.
//
// `key` empty means the vendor's key was removed, which is exactly what the caller means by a
// clear: the vendor is pushed with no key rather than with the stale one.
void pushAiConfig(MgmtdServiceManager& sm, const char* reason, const std::string& providerId,
                  const std::string& key);

}
