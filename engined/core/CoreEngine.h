#pragma once

#include "core/Core.h"

namespace nf::engined
{

class CoreEngine : public nf::core::Core
{
public:
    CoreEngine();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;
};

} // namespace nf::engined
