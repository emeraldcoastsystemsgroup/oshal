' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: MarkupGrid item renderer for a single smart-home device on the Roku surface — name + on/off pill, focus ring, and an "on" accent border. Pure view bound to itemContent (ADR-047).

' Cache child nodes once.
sub init()
    m.bg = m.top.findNode("bg")
    m.inner = m.top.findNode("inner")
    m.ring = m.top.findNode("ring")
    m.name = m.top.findNode("name")
    m.state = m.top.findNode("state")
end sub

' Render whenever the grid binds a new device to this reused card.
sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.name.text = c.title
    on = (c.state = "on")
    if on then
        m.state.text = "On"
        m.state.color = "0x00d3a7ff"
        m.inner.color = "0x1b2622ff"   ' subtle on-tint
    else
        m.state.text = "Off"
        m.state.color = "0x8b8ba3ff"
        m.inner.color = "0x15151fff"
    end if
end sub

' Show the accent focus ring only while this card holds D-pad focus.
sub onFocus()
    m.ring.opacity = m.top.focusPercent
end sub
