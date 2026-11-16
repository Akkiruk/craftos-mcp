/*
 * apis/http_emscripten.cpp
 * craftos-agent: the browser build has no http (engine/web/web.cmake). http.cpp includes this file instead of its
 * own body under __EMSCRIPTEN__. The http API is never loaded (config.http_enable is off in the web build's config);
 * these are the symbols the rest of the engine links against.
 */

#ifdef __EMSCRIPTEN__
#include <functional>
#include <istream>
#include <string>
#include <Poco/Exception.h>
#include <Poco/Net/HTTPResponse.h>
#include "../util.hpp"

static luaL_Reg http_reg[] = {
    {NULL, NULL}
};

library_t http_lib = {"http", http_reg, nullptr, nullptr};

void HTTPDownload(const std::string& url, const std::function<void(std::istream*, Poco::Exception*, Poco::Net::HTTPResponse*)>& callback) {
    Poco::Exception e("http is not available in the browser build");
    callback(NULL, &e, NULL);
}

void http_server_stop() {}

void stopWebsocket(void*) {}

#endif
