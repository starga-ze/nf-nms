#include "core/CoreIpc.h"

#include <memory>

using namespace nf::ipcd;

int main() 
{
    auto core = std::make_unique<CoreIpc>();

    core->run();

    return 0;
}
