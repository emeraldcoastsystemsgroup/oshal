' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: Roku channel entry point. Creates the SceneGraph screen, runs HomeScene, and pumps the event loop until the user exits. Surface only (ADR-047) — no reasoning, no device state on the Roku; it pairs once then reads the OSHAL home API.

' Channel entry point. Roku calls Main() on launch; everything else lives in SceneGraph.
sub Main()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)

    scene = screen.CreateScene("HomeScene")
    screen.show()

    ' Standard SceneGraph event loop: exit when the screen is closed (BACK off the root).
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub
