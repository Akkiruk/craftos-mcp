-- Runs a program the way CIDE's editor does (/rom/cide/run.lua), reporting whether a debug session is live.
local program = ... or "examples/cide/hello.lua"
print(cide_dbg.isActive() and "a debugger is attached" or "no debugger: the program runs straight through")
shell.run("/rom/cide/run.lua", program)
