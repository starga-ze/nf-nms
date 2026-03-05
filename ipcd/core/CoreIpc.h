#pragma once

#include "core/Core.h"

namespace nf::ipcd
{

class CoreIpc : public nf::core::Core
{
public:
    CoreIpc();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;
};

} // namespace nf::ipcd
