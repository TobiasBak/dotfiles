import QtQuick
import Quickshell.Io

Item {
    id: root

    property var workspaces: []
    property var windows: []

    function activateWorkspace(activation) {
        var activeWorkspace = workspaces.find(workspace => workspace.id === activation.id)
        if (!activeWorkspace) return

        workspaces = workspaces.map(workspace => {
            var updated = Object.assign({}, workspace)
            if (workspace.output === activeWorkspace.output) updated.is_active = workspace.id === activation.id
            if (activation.focused) updated.is_focused = workspace.id === activation.id
            return updated
        })
    }

    function updateWindow(window) {
        var found = false
        var updatedWindows = windows.map(existing => {
            if (existing.id !== window.id) return existing
            found = true
            return window
        })
        if (!found) updatedWindows.push(window)
        windows = updatedWindows
    }

    function closeWindow(id) {
        windows = windows.filter(window => window.id !== id)
    }

    function focusWindow(id) {
        windows = windows.map(window => {
            var updated = Object.assign({}, window)
            updated.is_focused = window.id === id
            return updated
        })
    }

    Timer {
        id: retryTimer
        interval: 2000
        onTriggered: {
            if (!eventStream.running) eventStream.running = true
        }
    }

    Process {
        id: eventStream
        command: ["niri", "msg", "--json", "event-stream"]
        running: true
        stdout: SplitParser {
            splitMarker: "\n"
            onRead: data => {
                if (!data || data.trim() === "") return

                try {
                    var event = JSON.parse(data)
                    if (event.WorkspacesChanged) {
                        root.workspaces = event.WorkspacesChanged.workspaces
                    } else if (event.WorkspaceActivated) {
                        root.activateWorkspace(event.WorkspaceActivated)
                    }

                    if (event.WindowsChanged) {
                        root.windows = event.WindowsChanged.windows
                    } else if (event.WindowOpenedOrChanged) {
                        root.updateWindow(event.WindowOpenedOrChanged.window)
                    } else if (event.WindowClosed) {
                        root.closeWindow(event.WindowClosed.id)
                    } else if (event.WindowFocusChanged) {
                        root.focusWindow(event.WindowFocusChanged.id)
                    }
                } catch (error) {
                    console.warn("Could not parse niri event: " + error)
                }
            }
        }
        onRunningChanged: {
            if (!running && !retryTimer.running) retryTimer.start()
        }
    }
}
