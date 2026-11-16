/*
 * peripheral/monitor.hpp
 * CraftOS-PC 2
 * 
 * This file defines the class for the monitor peripheral.
 * 
 * This code is licensed under the MIT license.
 * Copyright (c) 2019-2024 JackMacWindows.
 */

#ifndef PERIPHERAL_MONITOR_HPP
#define PERIPHERAL_MONITOR_HPP
#include <chrono>
#include <string>
#include <SDL2/SDL.h>
#include <peripheral.hpp>
#include <Terminal.hpp>
struct Computer;
#ifdef scroll
#undef scroll
#endif

class monitor : public peripheral {
private:
    unsigned char colors = 0xF0;
    // Headless terminals have no charScale, so the scale and the block size are kept here and the grid is
    // recomputed like CC:Tweaked does: round((64 * blocks - 20) / (6 * scale)).
    // CC keeps palette colours as floats; the terminal stores bytes, so remember what was set to give it back exactly
    float paletteF[16][3];
    unsigned short paletteSet = 0;
    unsigned headlessScale = 2; // text scale * 2, like SDLTerminal::charScale
    unsigned blocksW = 0, blocksH = 0; // 0 until setBlockSize is called
    std::chrono::high_resolution_clock::time_point last_blink = std::chrono::high_resolution_clock::now();
    // CC sends monitor_resize about a tick after the size really changes (setTextScale, a wall that grows or shrinks)
    Computer * comp = NULL;
    std::string side;
    SDL_TimerID resizeTimer = 0;
    void * resizePending = NULL;
    std::chrono::steady_clock::time_point lastResize;
    void resized();
    int write(lua_State *L);
    int scroll(lua_State *L);
    int setCursorPos(lua_State *L);
    int setCursorBlink(lua_State *L);
    int getCursorPos(lua_State *L);
    int getCursorBlink(lua_State *L);
    int getSize(lua_State *L);
    int clear(lua_State *L);
    int clearLine(lua_State *L);
    int setTextColor(lua_State *L);
    int setBackgroundColor(lua_State *L);
    int isColor(lua_State *L);
    int getTextColor(lua_State *L);
    int getBackgroundColor(lua_State *L);
    int blit(lua_State *L);
    int getPaletteColor(lua_State *L);
    int setPaletteColor(lua_State *L);
    int setGraphicsMode(lua_State *L);
    int getGraphicsMode(lua_State *L);
    int setPixel(lua_State *L);
    int getPixel(lua_State *L);
    int setTextScale(lua_State *L);
    int getTextScale(lua_State *L);
    int drawPixels(lua_State *L);
    int getPixels(lua_State *L);
    int screenshot(lua_State *L);
    int setFrozen(lua_State *L);
    int getFrozen(lua_State *L);
    int setSize(lua_State *L);
    int setBlockSize(lua_State *L);
public:
    Terminal * term;
    static library_t methods;
    static peripheral * init(lua_State *L, const char * side) {return new monitor(L, side);}
    static void deinit(peripheral * p) {delete (monitor*)p;}
    destructor getDestructor() const override {return deinit;}
    library_t getMethods() const override {return methods;}
    monitor(lua_State *L, const char * side);
    ~monitor();
    int call(lua_State *L, const char * method) override;
};
#endif
