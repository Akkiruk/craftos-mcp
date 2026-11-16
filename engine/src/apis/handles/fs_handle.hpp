/*
 * apis/handles/fs_handle.hpp
 * CraftOS-PC 2
 * 
 * This file defines the methods for file handles.
 * 
 * This code is licensed under the MIT license.
 * Copyright (c) 2019-2024 JackMacWindows.
 */

#ifndef FS_HANDLE_HPP
#define FS_HANDLE_HPP
extern "C" {
#include <lua.h>
}
extern int fs_handle_close(lua_State *L);
extern int fs_handle_gc(lua_State *L);
extern int fs_handle_readAll(lua_State *L);
extern int fs_handle_readLine(lua_State *L);
extern int fs_handle_readChar(lua_State *L);
extern int fs_handle_readByte(lua_State *L);
extern int fs_handle_readAllByte(lua_State *L);
extern int fs_handle_readAllText(lua_State *L);
#ifdef __cplusplus
#include <string>
/** UTF-8 file contents to 8-bit characters, like CC's text mode (code points above 255 and bad bytes become '?'). */
extern std::string decodeTextFile(const std::string& raw);
/** 8-bit characters to UTF-8, like CC's text-mode writes. */
extern std::string encodeTextString(const char * str, size_t len);
/** Number formatting of Java's Double.toString, which CC uses when a number is written to a file. */
extern std::string javaDoubleToString(double d);
#endif
extern int fs_handle_writeString(lua_State *L);
extern int fs_handle_writeLine(lua_State *L);
extern int fs_handle_writeByte(lua_State *L);
extern int fs_handle_flush(lua_State *L);
extern int fs_handle_seek(lua_State *L);
#endif