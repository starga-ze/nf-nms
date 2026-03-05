#include "core/CoreEngine.h"

#include <memory>

using namespace nf::engined;

int main()
{
    auto core = std::make_unique<CoreEngine>();

    core->run();

    return 0;
}
