// craftos-agent browser build (engine/web/web.cmake): a stand-in for NetSSL's Context, which needs OpenSSL.
// platform.hpp names Context::Ptr in one declaration; nothing in the web build makes or uses one.
#ifndef CRAFTOS_WEB_POCO_NET_CONTEXT_H
#define CRAFTOS_WEB_POCO_NET_CONTEXT_H
#include <Poco/AutoPtr.h>
#include <Poco/RefCountedObject.h>

namespace Poco {
namespace Net {

class Context : public Poco::RefCountedObject {
public:
    using Ptr = Poco::AutoPtr<Context>;
};

} // namespace Net
} // namespace Poco

#endif
