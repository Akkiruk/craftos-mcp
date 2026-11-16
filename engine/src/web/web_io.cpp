/*
 * web/web_io.cpp
 * craftos-agent: the browser build's raw-protocol bridge (engine/web/web.cmake).
 *
 * Native raw mode writes frames to stdout and reads them from stdin. In the browser the page calls
 * craftos_web_attach() once before main(), and from then on:
 *  - every frame the engine writes (rawWriter) goes to Module.onRawOutput(text) on the page's thread;
 *  - craftos_web_input(ptr, len) hands the engine raw-protocol bytes from the page; the raw input thread reads them
 *    through std::cin, which blocks on a condition variable until the page sends more.
 */

#ifdef __EMSCRIPTEN__
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <iostream>
#include <mutex>
#include <streambuf>
#include <string>
#include <emscripten/emscripten.h>

extern std::function<void(const std::string&)> rawWriter;

namespace {

/** std::cin for the raw input thread: bytes the page sent, blocking while there are none. */
class PageInputBuffer : public std::streambuf {
public:
    void push(const char* data, size_t len) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            queue_.insert(queue_.end(), data, data + len);
        }
        ready_.notify_all();
    }

protected:
    int_type underflow() override {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock, [this] { return !queue_.empty(); });
        const size_t n = std::min(queue_.size(), sizeof(chunk_));
        for (size_t i = 0; i < n; i++) chunk_[i] = queue_[i];
        queue_.erase(queue_.begin(), queue_.begin() + n);
        setg(chunk_, chunk_, chunk_ + n);
        return traits_type::to_int_type(chunk_[0]);
    }

private:
    std::mutex mutex_;
    std::condition_variable ready_;
    std::deque<char> queue_;
    char chunk_[4096];
};

PageInputBuffer pageInput;

std::mutex pauseMutex;
std::condition_variable pauseChanged;
bool paused = false;

} // namespace

extern "C" {

/** Called by the page once, after the runtime is up and before main() runs. */
EMSCRIPTEN_KEEPALIVE void craftos_web_attach() {
    std::cin.rdbuf(&pageInput);
    rawWriter = [](const std::string& data) {
        // Copy it: the call runs later on the page's thread, which frees the copy.
        char* copy = (char*)malloc(data.size() + 1);
        memcpy(copy, data.data(), data.size());
        copy[data.size()] = 0;
        MAIN_THREAD_ASYNC_EM_ASM({
            const text = UTF8ToString($0, $1);
            _free($0);
            if (Module.onRawOutput) Module.onRawOutput(text);
        }, copy, (int)data.size());
    };
}

/** Raw-protocol bytes from the page (complete "!CPC..." frames, or any part of them). */
EMSCRIPTEN_KEEPALIVE void craftos_web_input(const char* data, int len) {
    if (len > 0) pageInput.push(data, (size_t)len);
}

/**
 * Pause (1) or resume (0) every computer of this engine. A paused computer stops at its next yield (runtime.cpp
 * getNextEvent waits in craftos_web_wait_while_paused); its timers still fire and queue up for when it resumes.
 */
EMSCRIPTEN_KEEPALIVE void craftos_web_pause(int on) {
    {
        std::lock_guard<std::mutex> lock(pauseMutex);
        paused = on != 0;
    }
    pauseChanged.notify_all();
}

void craftos_web_wait_while_paused() {
    std::unique_lock<std::mutex> lock(pauseMutex);
    pauseChanged.wait(lock, [] { return !paused; });
}

}
#endif
