' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: HomeScene controller for the Roku surface. Device-link pairing (start → poll → store token), live device grid + scene list from /api/home, instant toggle (/control) and scene run (/scene/run), and 401 → re-pair. Holds only host+token in the registry; all reasoning lives on the OSHAL host (ADR-047).
' 2 | maintainer@emeraldcoastsystemsgroup.com   | Jarvis-first: pairing now shows a scannable login QR (Poster ← /api/tv/pair/qr); after auth the default screen is the Jarvis view — a scan-to-talk QR for the phone push-to-talk remote + the live conversation polled from /api/jarvis/history. The Smart Home device grid is secondary (toggle with the * / Options key). ADR-068.

' Default OSHAL host — matches the Fire TV default so the channel works out of the box.
' Override by writing "host" into the "oshal" registry section (see README.md).
const DEFAULT_HOST = "https://oshal.agenticfederal.us"

' ── Lifecycle ────────────────────────────────────────────────────────────────
sub init()
    m.pairGroup = m.top.findNode("pairGroup")
    m.jarvisGroup = m.top.findNode("jarvisGroup")
    m.contentGroup = m.top.findNode("contentGroup")
    m.status = m.top.findNode("status")
    m.pairInstr = m.top.findNode("pairInstr")
    m.pairCode = m.top.findNode("pairCode")
    m.pairState = m.top.findNode("pairState")
    m.pairQr = m.top.findNode("pairQr")
    m.jStatus = m.top.findNode("jStatus")
    m.transcript = m.top.findNode("transcript")
    m.jEmpty = m.top.findNode("jEmpty")
    m.talkQr = m.top.findNode("talkQr")
    m.scenesList = m.top.findNode("scenesList")
    m.grid = m.top.findNode("grid")
    m.toast = m.top.findNode("toast")
    m.pollTimer = m.top.findNode("pollTimer")
    m.jarvisTimer = m.top.findNode("jarvisTimer")

    m.host = regRead("host", DEFAULT_HOST)
    m.token = regRead("token", "")
    m.room = regRead("room", "Roku TV")   ' which "room" this screen answers as (phone targets it)
    m.jSession = ""                        ' room-scoped Jarvis session (set after register)
    m.tick = 0
    m.scenes = []
    m.devices = []
    m.deviceCode = ""
    m.retryStart = false

    m.scenesList.observeField("itemSelected", "onSceneSelected")
    m.grid.observeField("itemSelected", "onDeviceSelected")
    m.pollTimer.observeField("fire", "onPollTick")
    m.jarvisTimer.observeField("fire", "onJarvisTick")

    if m.token = "" then
        startPairing()
    else
        showJarvis()
    end if
end sub

' ── Pairing (device-link) ──────────────────────────────────────────────────────
sub startPairing()
    m.jarvisTimer.control = "stop"
    m.pairGroup.visible = true
    m.jarvisGroup.visible = false
    m.contentGroup.visible = false
    m.status.text = "Not connected"
    m.pairState.text = "Starting…"
    m.startTask = http("POST", "/api/tv/pair/start", "")
    m.startTask.observeField("done", "onPairStartDone")
    m.startTask.control = "RUN"
end sub

sub onPairStartDone()
    if m.startTask.code <> 200 then
        m.pairState.text = "Couldn't reach OSHAL (" + m.startTask.code.toStr() + "). Retrying in 5s…"
        m.pollTimer.control = "start"   ' reuse the timer to retry start
        m.retryStart = true
        return
    end if
    j = ParseJson(m.startTask.response)
    if j = invalid then return
    m.deviceCode = j.device_code
    m.pairInstr.text = "Scan the code with your phone — or go to " + shortUrl(j.verification_uri) + " and sign in."
    m.pairCode.text = j.user_code
    if j.qr_url <> invalid then m.pairQr.uri = j.qr_url
    m.pairState.text = "Waiting for you to approve on your phone…"
    m.retryStart = false
    m.pollTimer.control = "start"       ' poll every 5s (Timer duration)
end sub

' Timer tick: either retry a failed start, or poll for approval.
sub onPollTick()
    if m.retryStart = true then
        m.pollTimer.control = "stop"
        startPairing()
        return
    end if
    if m.deviceCode = invalid or m.deviceCode = "" then return
    m.pollTask = http("POST", "/api/tv/pair/poll", FormatJson({ device_code: m.deviceCode }))
    m.pollTask.observeField("done", "onPollDone")
    m.pollTask.control = "RUN"
end sub

sub onPollDone()
    j = ParseJson(m.pollTask.response)
    if j = invalid then return
    if j.status = "approved" then
        m.pollTimer.control = "stop"
        m.token = j.token
        regWrite("token", m.token)
        m.deviceCode = ""
        showJarvis()
    else if j.status = "expired" then
        m.pollTimer.control = "stop"
        startPairing()      ' code expired — start over
    end if
end sub

' ── Jarvis surface (default after auth) ────────────────────────────────────────
sub showJarvis()
    m.pollTimer.control = "stop"
    m.pairGroup.visible = false
    m.contentGroup.visible = false
    m.jarvisGroup.visible = true
    m.status.text = ""
    m.jStatus.text = "Listening on your phone — " + m.room
    ' Scan-to-talk QR carries this screen's room so the phone pre-selects it.
    m.talkQr.uri = m.host + "/api/tv/pair/qr?target=remote&room=" + slugify(m.room)
    registerRoom()                    ' claim this room → get the room-scoped session
    loadHistory()
    m.jarvisTimer.control = "start"   ' poll the conversation every 3s
end sub

' Claim/refresh this screen's room so the phone can target it; the reply uses its session thread.
sub registerRoom()
    m.regTask = http("POST", "/api/jarvis/tv/register", FormatJson({ room: m.room }))
    m.regTask.observeField("done", "onRegisterDone")
    m.regTask.control = "RUN"
end sub

sub onRegisterDone()
    if handleAuth(m.regTask.code) then return
    j = ParseJson(m.regTask.response)
    if j <> invalid and j.sessionId <> invalid then m.jSession = j.sessionId
end sub

sub onJarvisTick()
    m.tick = m.tick + 1
    if m.tick mod 10 = 0 then registerRoom()   ' heartbeat ~every 30s so we stay targetable
    loadHistory()
end sub

sub loadHistory()
    path = "/api/jarvis/history"
    if m.jSession <> "" then path = path + "?sessionId=" + m.jSession
    m.histTask = http("GET", path, "")
    m.histTask.observeField("done", "onHistoryDone")
    m.histTask.control = "RUN"
end sub

sub onHistoryDone()
    if handleAuth(m.histTask.code) then return
    j = ParseJson(m.histTask.response)
    if j = invalid then return
    turns = j.turns
    if turns = invalid or turns.count() = 0 then return
    m.jEmpty.visible = false
    m.transcript.text = buildTranscript(turns)
end sub

' Render the last few turns as "You:" / "Jarvis:" lines, newest at the bottom.
function buildTranscript(turns as object) as string
    startIdx = 0
    if turns.count() > 10 then startIdx = turns.count() - 10
    out = ""
    for i = startIdx to turns.count() - 1
        t = turns[i]
        who = "Jarvis: "
        if t.role = "user" then who = "You: "
        if out <> "" then out = out + Chr(10)
        out = out + who + t.text
    next
    return out
end function

' ── Smart Home (secondary) ─────────────────────────────────────────────────────
sub showContent()
    m.jarvisTimer.control = "stop"
    m.pairGroup.visible = false
    m.jarvisGroup.visible = false
    m.contentGroup.visible = true
    m.status.text = "Loading…"
    loadData()
end sub

sub loadData()
    m.devTask = http("GET", "/api/home/devices", "")
    m.devTask.observeField("done", "onDevicesDone")
    m.devTask.control = "RUN"
    m.sceneTask = http("GET", "/api/home/scenes", "")
    m.sceneTask.observeField("done", "onScenesDone")
    m.sceneTask.control = "RUN"
end sub

sub onDevicesDone()
    if handleAuth(m.devTask.code) then return
    j = ParseJson(m.devTask.response)
    if j = invalid then return
    devices = j.devices
    if devices = invalid then devices = []
    m.devices = devices
    root = CreateObject("roSGNode", "ContentNode")
    for each d in devices
        item = root.createChild("ContentNode")
        item.addField("state", "string", false)
        item.addField("deviceKey", "string", false)
        nm = d.userName
        if nm = invalid or nm = "" then nm = d.name
        item.title = nm
        sw = d["switch"]
        st = "off"
        if sw <> invalid and sw = "on" then st = "on"
        item.state = st
        item.deviceKey = d.key
    next
    m.grid.content = root
    hubs = j.hubs
    suffix = ""
    if hubs <> invalid and hubs.count() > 0 then suffix = " · " + joinArr(hubs, ", ")
    m.status.text = devices.count().toStr() + " devices" + suffix
    m.grid.setFocus(true)
end sub

sub onScenesDone()
    if handleAuth(m.sceneTask.code) then return
    j = ParseJson(m.sceneTask.response)
    if j = invalid then return
    scenes = j.scenes
    if scenes = invalid then scenes = []
    m.scenes = scenes
    root = CreateObject("roSGNode", "ContentNode")
    for each s in scenes
        item = root.createChild("ContentNode")
        item.title = s.name
    next
    m.scenesList.content = root
end sub

' ── Actions ──────────────────────────────────────────────────────────────────
sub onDeviceSelected()
    idx = m.grid.itemSelected
    if m.devices = invalid or idx < 0 or idx >= m.devices.count() then return
    d = m.devices[idx]
    sw = d["switch"]
    nextCmd = "on"
    if sw <> invalid and sw = "on" then nextCmd = "off"
    m.ctlTask = http("POST", "/api/home/control", FormatJson({ device: d.key, cmd: nextCmd }))
    m.ctlTask.observeField("done", "onActionDone")
    m.ctlTask.control = "RUN"
    showToast(d.key + " → " + nextCmd)
end sub

sub onSceneSelected()
    idx = m.scenesList.itemSelected
    if m.scenes = invalid or idx < 0 or idx >= m.scenes.count() then return
    name = m.scenes[idx].name
    m.runTask = http("POST", "/api/home/scene/run", FormatJson({ name: name }))
    m.runTask.observeField("done", "onActionDone")
    m.runTask.control = "RUN"
    showToast("Running " + name + "…")
end sub

' After any control/scene action, reload devices so the surface reflects the new state.
sub onActionDone()
    loadData()
end sub

' ── Remote keys ──────────────────────────────────────────────────────────────
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "options" then          ' the * button toggles Jarvis ⇆ Smart Home
        if m.contentGroup.visible then
            showJarvis()
        else if m.jarvisGroup.visible then
            showContent()
        end if
        return true
    else if key = "right" then
        if m.scenesList.hasFocus() then
            m.grid.setFocus(true)
            return true
        end if
    else if key = "left" then
        if m.grid.hasFocus() and m.scenes.count() > 0 then
            m.scenesList.setFocus(true)
            return true
        end if
    else if key = "back" then
        return false   ' let the screen close → exit channel
    end if
    return false
end function

' ── Helpers ──────────────────────────────────────────────────────────────────
' 401 → the token is dead; clear it and re-pair. Returns true when it handled the response.
function handleAuth(code as integer) as boolean
    if code = 401 then
        regWrite("token", "")
        m.token = ""
        startPairing()
        return true
    end if
    return false
end function

' Build (but do not start) an HttpTask for the given method/path/body with the current token.
function http(method as string, path as string, body as string) as object
    t = CreateObject("roSGNode", "HttpTask")
    t.method = method
    t.url = m.host + path
    t.token = m.token
    t.body = body
    return t
end function

sub showToast(text as string)
    m.toast.text = text
end sub

' Slugify a room label for the QR ?room= param (lowercase a-z0-9, spaces→dashes).
function slugify(s as string) as string
    src = LCase(s)
    out = ""
    for i = 1 to Len(src)
        ch = Mid(src, i, 1)
        if (ch >= "a" and ch <= "z") or (ch >= "0" and ch <= "9") then
            out = out + ch
        else if out <> "" and Right(out, 1) <> "-" then
            out = out + "-"
        end if
    next
    if Right(out, 1) = "-" then out = Left(out, Len(out) - 1)
    return out
end function

' Strip scheme for a cleaner on-screen verification URL.
function shortUrl(u as string) as string
    s = u
    s = s.replace("https://", "")
    s = s.replace("http://", "")
    return s
end function

function joinArr(arr as object, sep as string) as string
    out = ""
    for i = 0 to arr.count() - 1
        if i > 0 then out = out + sep
        out = out + arr[i]
    next
    return out
end function

' ── Registry (host + token persistence) ────────────────────────────────────────
function regRead(key as string, fallback as string) as string
    sec = CreateObject("roRegistrySection", "oshal")
    if sec.exists(key) then
        v = sec.read(key)
        if v <> invalid and v <> "" then return v
    end if
    return fallback
end function

sub regWrite(key as string, value as string)
    sec = CreateObject("roRegistrySection", "oshal")
    sec.write(key, value)
    sec.flush()
end sub
