' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: one-shot HTTPS request on a Task thread (roUrlTransfer is banned on the render thread). Sends the TV bearer token + JSON body, returns status code + raw body to the owner via observed fields. Powers all OSHAL home API calls from the Roku surface (ADR-047).

' Task entry — Roku invokes this when control = "RUN".
sub init()
    m.top.functionName = "runRequest"
end sub

' Perform one HTTPS request synchronously (Task threads may block) and publish the result.
sub runRequest()
    ut = CreateObject("roUrlTransfer")
    ut.setUrl(m.top.url)
    ut.setCertificatesFile("common:/certs/ca-bundle.crt")  ' enable TLS validation
    ut.initClientCertificates()
    ut.setRequest(m.top.method)

    headers = { "Content-Type": "application/json", "Accept": "application/json" }
    if m.top.token <> "" then headers["X-OSHAL-TV-Token"] = m.top.token
    ut.setHeaders(headers)

    port = CreateObject("roMessagePort")
    ut.setMessagePort(port)
    ut.setPort(port)

    ok = false
    if m.top.method = "GET" then
        ok = ut.asyncGetToString()
    else
        ok = ut.asyncPostFromString(m.top.body)
    end if

    if not ok then
        publish(-1, "")
        return
    end if

    ' Wait up to 20s for the transfer event, then read code + body off it.
    msg = wait(20000, port)
    if type(msg) = "roUrlEvent" then
        publish(msg.getResponseCode(), msg.getString())
    else
        publish(-2, "")   ' timeout / no event
    end if
end sub

' Set outputs in a single observed flip so the owner sees a consistent snapshot.
sub publish(code as integer, response as string)
    m.top.code = code
    m.top.response = response
    m.top.done = true
end sub
