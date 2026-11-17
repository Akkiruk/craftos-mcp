// One line of our own for each generated module, function and class. The ROM's doc comments are CC:Tweaked's text
// under its own licence, so none of it is copied into the library: generate.mjs takes names, types and versions from
// them, the description from here, and links every entry to its page on tweaked.cc for the real documentation.
//
// Keys: "module", "module.name", "module.Class", "module.Class:method". A name without a line gets only the link;
// generate.mjs lists those, so a new CC:Tweaked function is noticed.
export const SUMMARIES = {
  // ===== colors / colours (the generator copies colors.* to colours.*) =====
  colors:
    "The 16 colours of a terminal as numbers, and helpers to combine and convert them.",
  colours: "The same as `colors`, with British spelling (`grey`, `lightGrey`).",
  "colors.combine": "Add colours together into one set, as bundled cables use.",
  "colors.subtract": "Take colours out of a set.",
  "colors.test": "Whether a set contains a colour.",
  "colors.packRGB": "Three channels from 0 to 1 as one 24-bit RGB number.",
  "colors.unpackRGB": "A 24-bit RGB number as three channels from 0 to 1.",
  "colors.rgb8":
    "Old name for both `packRGB` and `unpackRGB`, picked by the number of arguments.",
  "colors.toBlit": "A colour as the hex digit `term.blit` uses.",
  "colors.fromBlit": "The colour a `term.blit` hex digit stands for.",

  // ===== commands =====
  commands:
    'Run Minecraft commands from a command computer. Every command is also a function: `commands.say("hi")`.',
  "commands.native": "The API without the per-command functions.",
  "commands.async":
    "Every command as a function that does not wait: it returns a task id, as `commands.execAsync`.",

  // ===== disk =====
  disk: "Shortcuts for the disk drive on a side or network name.",
  "disk.isPresent": "Whether something is in the drive.",
  "disk.getLabel": "The label of the disk, or nil.",
  "disk.setLabel": "Set the label of the disk, or clear it with nil.",
  "disk.hasData": "Whether the disk holds files.",
  "disk.getMountPath": "Where the disk's files are, such as `disk`.",
  "disk.hasAudio": "Whether the disk is a music disc.",
  "disk.getAudioTitle": "The title of the music disc.",
  "disk.playAudio": "Play the music disc.",
  "disk.stopAudio": "Stop the music.",
  "disk.eject": "Eject the disk.",
  "disk.getID": "The id of the floppy disk, or nil.",

  // ===== fs (the Lua part) =====
  "fs.complete":
    "File and folder names that complete a partial path, for `read`.",
  "fs.find": "Every path that matches a pattern with `*` wildcards.",
  "fs.isDriveRoot":
    "Whether a path is the top of a drive (`/`, `rom`, `disk`).",

  // ===== gps =====
  gps: "Find this computer's position from GPS hosts in wireless range.",
  "gps.CHANNEL_GPS": "The modem channel GPS uses.",
  "gps.locate":
    "Ask the GPS hosts where this computer is. Nil when too few answer in time.",

  // ===== help =====
  help: "Find the help files the `help` program shows.",
  "help.path": "The folders searched for help files, separated by `:`.",
  "help.setPath": "Set the folders searched for help files.",
  "help.lookup": "The path of the help file for a topic, or nil.",
  "help.topics": "Every help topic.",
  "help.completeTopic": "Topics that complete a partial name.",

  // ===== http =====
  http: "Make HTTP requests and open websockets.",
  "http.get":
    "Send a GET request and wait for the response. Nil and a message when it fails.",
  "http.post":
    "Send a POST request and wait for the response. Nil and a message when it fails.",
  "http.request":
    "Send a request without waiting: `http_success` or `http_failure` is queued when it ends.",
  "http.checkURL":
    "Whether a URL may be requested. False and a reason when not.",
  "http.checkURLAsync":
    "Check a URL without waiting: `http_check` is queued with the answer.",
  "http.websocket":
    "Open a websocket and wait for it. False and a message when it fails.",
  "http.websocketAsync":
    "Open a websocket without waiting: `websocket_success` or `websocket_failure` is queued.",

  // ===== io =====
  io: "Lua's `io` library, rebuilt on top of `fs`.",
  "io.stdin": "Reads what the user types.",
  "io.stdout": "Writes to the terminal.",
  "io.stderr": "Writes to the terminal in red.",
  "io.close": "Close a file, or the current output file.",
  "io.flush": "Save what was written to the current output file.",
  "io.input": "The current input file; with an argument, set it.",
  "io.lines":
    "An iterator over the lines of a file, which is closed at the end.",
  "io.open": "Open a file. Nil and a message when it cannot be opened.",
  "io.output": "The current output file; with an argument, set it.",
  "io.read": "Read from the current input file.",
  "io.type":
    '`"file"` for an open handle, `"closed file"` for a closed one, nil for anything else.',
  "io.write": "Write to the current output file.",
  "io.Handle":
    "A file opened with `io.open`. Its functions are called with `:`.",
  "io.Handle:close": "Close the file.",
  "io.Handle:flush": "Save what was written so far.",
  "io.Handle:lines": "An iterator over the lines of the file.",
  "io.Handle:read":
    'Read by format: `"l"` a line, `"a"` the rest, `"n"` a number, or a count of characters.',
  "io.Handle:seek": "Move to a position in the file and return it.",
  "io.Handle:setvbuf": "Does nothing in CC:Tweaked.",
  "io.Handle:write":
    "Write values and return the handle, so calls can be chained.",

  // ===== keys =====
  keys: "Key codes by name, as the `key` and `key_up` events give them.",
  "keys.getName": "The name of a key code, or nil.",

  // ===== multishell =====
  multishell: "Run programs in tabs. Only on advanced computers.",
  "multishell.getFocus": "The tab that is shown.",
  "multishell.setFocus": "Show a tab.",
  "multishell.getTitle": "The title of a tab.",
  "multishell.setTitle": "Set the title of a tab.",
  "multishell.getCurrent": "The tab this program runs in.",
  "multishell.launch":
    "Start a program in a new tab and return the tab's number.",
  "multishell.getCount": "How many tabs there are.",

  // ===== paintutils =====
  paintutils: "Draw pixels, lines, boxes and images on the terminal.",
  "paintutils.parseImage": "An image from the text of a paint file.",
  "paintutils.loadImage":
    "An image from a paint file, or nil when the file is not there.",
  "paintutils.drawPixel": "Colour one character cell.",
  "paintutils.drawLine": "Draw a line between two points.",
  "paintutils.drawBox": "Draw the outline of a rectangle.",
  "paintutils.drawFilledBox": "Draw a filled rectangle.",
  "paintutils.drawImage":
    "Draw an image with its top left corner at a position.",

  // ===== parallel =====
  parallel:
    "Run several functions at the same time, each with its own copy of the events.",
  "parallel.waitForAny":
    "Run the functions together and return when the first one finishes.",
  "parallel.waitForAll":
    "Run the functions together and return when all have finished.",

  // ===== peripheral =====
  peripheral:
    "Find the blocks attached to the computer and call their methods.",
  "peripheral.getNames":
    "The names of every attached peripheral: sides, and names on a wired network.",
  "peripheral.isPresent": "Whether a peripheral is attached under a name.",
  "peripheral.getType":
    "The types of a peripheral, or nil when it is not there.",
  "peripheral.hasType":
    "Whether a peripheral is of a type. Nil when it is not there.",
  "peripheral.getMethods":
    "The method names of a peripheral, or nil when it is not there.",
  "peripheral.getName": "The name a wrapped peripheral is attached under.",
  "peripheral.call": "Call one method of a peripheral by name.",
  "peripheral.wrap":
    "A table with every method of a peripheral, or nil when it is not there.",
  "peripheral.find": "Every attached peripheral of a type, wrapped.",

  // ===== rednet =====
  rednet:
    "Send messages between computers over modems, by computer id and protocol.",
  "rednet.CHANNEL_BROADCAST": "The channel broadcasts are sent on.",
  "rednet.CHANNEL_REPEAT": "The channel repeaters listen on.",
  "rednet.MAX_ID_CHANNELS":
    "Computer ids wrap around to channels below this number.",
  "rednet.open": "Start using a modem for rednet.",
  "rednet.close": "Stop using a modem, or every modem, for rednet.",
  "rednet.isOpen": "Whether a modem, or any modem, is open for rednet.",
  "rednet.send":
    "Send a message to one computer. Says whether it was sent, not whether it arrived.",
  "rednet.broadcast": "Send a message to every computer in range.",
  "rednet.receive": "Wait for a message, optionally only of one protocol.",
  "rednet.host": "Answer lookups for a protocol under a name.",
  "rednet.unhost": "Stop answering lookups for a protocol.",
  "rednet.lookup":
    "The ids of the computers hosting a protocol, or the one with a given name.",
  "rednet.run":
    "The loop that turns modem messages into `rednet_message` events. The shell already runs it.",

  // ===== settings =====
  settings: "Named settings kept in the `.settings` file.",
  "settings.define": "Describe a setting: its default, type and description.",
  "settings.undefine": "Forget the description of a setting. Its value stays.",
  "settings.set":
    "Set a setting. Call `settings.save` to keep it after a reboot.",
  "settings.get": "The value of a setting, or a default.",
  "settings.getDetails":
    "The description, default, type and value of a setting.",
  "settings.unset": "Remove the value of a setting, so its default applies.",
  "settings.clear": "Remove the value of every setting.",
  "settings.getNames": "The names of every setting that is defined or set.",
  "settings.load": "Read settings from a file. Default `.settings`.",
  "settings.save": "Write settings to a file. Default `.settings`.",

  // ===== shell =====
  shell:
    "The CraftOS shell: run programs, resolve paths, complete commands. Only programs started from a shell have it.",
  "shell.execute": "Run a program with arguments given one by one.",
  "shell.run": "Run a command line, as if typed at the prompt.",
  "shell.exit": "Leave the shell once the current program ends.",
  "shell.dir": "The current folder.",
  "shell.setDir": "Change the current folder.",
  "shell.path": "The folders searched for programs, separated by `:`.",
  "shell.setPath": "Set the folders searched for programs.",
  "shell.resolve":
    "A path as typed by the user, made absolute from the current folder.",
  "shell.resolveProgram": "The file a program name runs, or nil.",
  "shell.programs": "Every program on the path.",
  "shell.complete": "Completions for a partial command line.",
  "shell.completeProgram": "Program names that complete a partial name.",
  "shell.setCompletionFunction":
    "Set the function that completes the arguments of a program.",
  "shell.getCompletionInfo":
    "The completion function of every program that has one.",
  "shell.getRunningProgram": "The path of the program that is running.",
  "shell.setAlias": "Give a program another name.",
  "shell.clearAlias": "Remove an alias.",
  "shell.aliases": "Every alias and what it stands for.",
  "shell.openTab":
    "Run a command line in a new multishell tab and return the tab's number.",
  "shell.switchTab": "Show a multishell tab.",

  // ===== term (the Lua part) =====
  "term.redirect":
    "Send everything `term` draws to another target, and return the one it replaces.",
  "term.current": "What `term` draws to now.",
  "term.native": "The computer's own screen, whatever `term` is redirected to.",

  // ===== textutils =====
  textutils:
    "Text helpers: serialising values and JSON, tables, paged and slow printing.",
  "textutils.empty_json_array":
    "Serialises to `[]`: an empty table would become `{}`.",
  "textutils.json_null": "Serialises to JSON `null`.",
  "textutils.slowWrite": "Write text one character at a time.",
  "textutils.slowPrint": "Print text one character at a time.",
  "textutils.formatTime": "A time from `os.time` as text, such as `6:30 PM`.",
  "textutils.pagedPrint":
    "Print text, pausing for a key each time the screen is full.",
  "textutils.tabulate":
    "Print lists as columns. A colour between lists changes the text colour.",
  "textutils.pagedTabulate":
    "Like `tabulate`, pausing for a key each time the screen is full.",
  "textutils.serialize":
    "A value as Lua source text, to save and read back with `unserialize`.",
  "textutils.serialise":
    "A value as Lua source text, to save and read back with `unserialise`.",
  "textutils.unserialize":
    "The value that text from `serialize` describes, or nil when it is not valid.",
  "textutils.unserialise":
    "The value that text from `serialise` describes, or nil when it is not valid.",
  "textutils.serializeJSON": "A value as JSON text.",
  "textutils.serialiseJSON": "A value as JSON text.",
  "textutils.unserializeJSON":
    "The value JSON text describes. Nil and a message when it is not valid.",
  "textutils.unserialiseJSON":
    "The value JSON text describes. Nil and a message when it is not valid.",
  "textutils.urlEncode": "Text made safe to put in a URL.",
  "textutils.complete":
    "Names of variables and table fields that complete a partial Lua expression.",

  // ===== turtle (the Lua part) =====
  "turtle.native":
    "The turtle API as the game provides it, before programs change it.",

  // ===== vector =====
  vector: "Vectors of three numbers, for positions and directions.",
  "vector.new": "A new vector.",
  "vector.Vector":
    "Three numbers `x`, `y`, `z`, with arithmetic. Its functions are called with `:`.",
  "vector.Vector:add": "This vector plus another. Also `a + b`.",
  "vector.Vector:sub": "This vector minus another. Also `a - b`.",
  "vector.Vector:mul": "This vector times a number. Also `a * n`.",
  "vector.Vector:div": "This vector divided by a number. Also `a / n`.",
  "vector.Vector:unm": "This vector pointing the other way. Also `-a`.",
  "vector.Vector:dot": "The dot product with another vector.",
  "vector.Vector:cross": "The cross product with another vector.",
  "vector.Vector:length": "The length of the vector.",
  "vector.Vector:normalize": "The vector of length 1 that points the same way.",
  "vector.Vector:round":
    "Each number rounded to the nearest multiple of a tolerance.",
  "vector.Vector:tostring": "The vector as text, `x,y,z`.",
  "vector.Vector:equals":
    "Whether another vector has the same three numbers. Also `a == b`.",

  // ===== window =====
  window:
    "Windows: areas of a terminal that are drawn to like a terminal and can be moved, hidden and redrawn.",
  "window.create": "A new window on a parent terminal.",
  "window.Window":
    "A window: every terminal function, plus those below. Its functions are called with `.`.",
  "window.Window:getLine":
    "The text, text colours and background colours of one line, as `term.blit` takes them.",
  "window.Window:setVisible":
    "Show or hide the window. A hidden window keeps what is drawn to it.",
  "window.Window:isVisible": "Whether the window is shown.",
  "window.Window:redraw": "Draw the window on its parent again.",
  "window.Window:restoreCursor":
    "Put the parent's cursor where this window's cursor is.",
  "window.Window:getPosition":
    "Where the window's top left corner is on its parent.",
  "window.Window:reposition":
    "Move the window, and optionally resize it or give it another parent.",

  // ===== cc.* modules =====
  "cc.audio.dfpwm":
    "Convert between DFPWM audio and the lists of samples a speaker plays.",
  "cc.audio.dfpwm.make_encoder":
    "A function that turns samples into DFPWM, keeping its state between calls.",
  "cc.audio.dfpwm.make_decoder":
    "A function that turns DFPWM into samples, keeping its state between calls.",
  "cc.audio.dfpwm.encode": "Samples to DFPWM in one go.",
  "cc.audio.dfpwm.decode": "DFPWM to samples in one go.",
  "cc.base64": "Encode and decode Base64.",
  "cc.base64.encode": "Data as Base64 text.",
  "cc.base64.decode":
    "The data Base64 text stands for. Nil and a message when it is not valid.",
  "cc.completion": "Completion functions for `read`.",
  "cc.completion.choice": "The choices that complete a partial text.",
  "cc.completion.peripheral": "Peripheral names that complete a partial text.",
  "cc.completion.side": "Sides that complete a partial text.",
  "cc.completion.setting": "Setting names that complete a partial text.",
  "cc.completion.command": "Command names that complete a partial text.",
  "cc.expect":
    "Check the types of a function's arguments. The module can be called itself, like `expect.expect`.",
  "cc.expect.expect":
    "Throw unless an argument is of one of the given types. Returns the value.",
  "cc.expect.field":
    "Throw unless a field of a table is of one of the given types. Returns the field.",
  "cc.expect.range":
    "Throw unless a number is within a range. Returns the number.",
  "cc.image.nft":
    "Read and draw NFT images, which carry text as well as colours.",
  "cc.image.nft.parse": "An image from the text of an NFT file.",
  "cc.image.nft.load":
    "An image from an NFT file. Nil and a message when it cannot be read.",
  "cc.image.nft.draw":
    "Draw an image at a position, on the terminal or another target.",
  "cc.pretty":
    "Lay out values and text as documents that wrap to the width of the terminal.",
  "cc.pretty.empty": "A document with nothing in it.",
  "cc.pretty.space": "A document of one space.",
  "cc.pretty.line": "A line break, or nothing when the group fits on one line.",
  "cc.pretty.space_line":
    "A line break, or a space when the group fits on one line.",
  "cc.pretty.text": "A document of some text, optionally coloured.",
  "cc.pretty.concat": "Documents joined into one. Also `a .. b`.",
  "cc.pretty.nest": "A document whose line breaks are indented.",
  "cc.pretty.group": "A document that is put on one line when it fits.",
  "cc.pretty.write": "Draw a document at the cursor.",
  "cc.pretty.print": "Draw a document and a newline.",
  "cc.pretty.render": "A document as plain text.",
  "cc.pretty.pretty": "Any Lua value as a document.",
  "cc.pretty.pretty_print":
    "Print any Lua value, laid out to fit the terminal.",
  "cc.pretty.Doc": "A document: text with the places where it may break.",
  "cc.shell.completion":
    "Completion functions for program arguments, for `shell.setCompletionFunction`.",
  "cc.shell.completion.file": "File names that complete a partial text.",
  "cc.shell.completion.dir": "Folder names that complete a partial text.",
  "cc.shell.completion.dirOrFile":
    "File and folder names that complete a partial text.",
  "cc.shell.completion.program": "Program names that complete a partial text.",
  "cc.shell.completion.programWithArgs":
    "A program name, then that program's own argument completion.",
  "cc.shell.completion.build":
    "One completion function out of one per argument.",
  "cc.shell.completion.choice":
    "`cc.completion.choice`, in the form `build` takes.",
  "cc.shell.completion.command":
    "`cc.completion.command`, in the form `build` takes.",
  "cc.shell.completion.help":
    "`help.completeTopic`, in the form `build` takes.",
  "cc.shell.completion.peripheral":
    "`cc.completion.peripheral`, in the form `build` takes.",
  "cc.shell.completion.setting":
    "`cc.completion.setting`, in the form `build` takes.",
  "cc.shell.completion.side":
    "`cc.completion.side`, in the form `build` takes.",
  "cc.strings": "Helpers for wrapping and padding text.",
  "cc.strings.wrap": "Text split into lines no wider than a width.",
  "cc.strings.ensure_width":
    "Text cut or padded with spaces to exactly a width.",
  "cc.strings.split": "Text split at a separator.",
};
