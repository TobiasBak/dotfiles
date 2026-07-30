import QtQuick
import Quickshell.Io

Item {
    id: root

    property int primaryPercent: -1
    property int secondaryPercent: -1
    property string primaryResetAt: ""
    property string secondaryResetAt: ""
    property string primaryPace: ""
    property string secondaryPace: ""
    property string accountEmail: ""
    property string loginMethod: ""
    property string sourceName: ""
    property real creditsRemaining: -1
    property string updatedAt: ""
    property string errorMessage: ""
    property bool loading: false
    property bool receivedOutput: false
    property bool binaryMissing: false
    property double nowMs: Date.now()

    function refresh() {
        if (binaryMissing || usageProcess.running)
            return

        loading = true
        receivedOutput = false
        errorMessage = ""
        usageProcess.running = true
    }

    function parsePercent(value) {
        var parsed = Number(value)
        return isNaN(parsed) ? -1 : Math.round(parsed)
    }

    function parseOutput(output) {
        try {
            var data = JSON.parse(String(output || "").trim())
            var item = Array.isArray(data) ? data[0] : data

            if (!item)
                throw new Error("CodexBar returned no usage data")
            if (item.error)
                throw new Error(item.error.message || String(item.error))

            var usage = item.usage || {}
            var primary = usage.primary || {}
            var secondary = usage.secondary || {}
            var identity = usage.identity || {}
            var credits = item.credits || {}
            var pace = item.pace || {}

            primaryPercent = parsePercent(primary.usedPercent)
            secondaryPercent = parsePercent(secondary.usedPercent)
            primaryResetAt = primary.resetsAt || ""
            secondaryResetAt = secondary.resetsAt || ""
            primaryPace = pace.primary ? pace.primary.summary || "" : ""
            secondaryPace = pace.secondary ? pace.secondary.summary || "" : ""
            accountEmail = usage.accountEmail || identity.accountEmail || ""
            loginMethod = usage.loginMethod || identity.loginMethod || ""
            sourceName = item.source || "codex-cli"
            creditsRemaining = credits.remaining === undefined ? -1 : Number(credits.remaining)
            updatedAt = usage.updatedAt || credits.updatedAt || new Date().toISOString()
            errorMessage = ""
        } catch (error) {
            errorMessage = error.message || "Could not parse Codex usage"
        }
    }

    Process {
        id: usageProcess
        command: [
            "codexbar",
            "usage",
            "--provider", "codex",
            "--source", "cli",
            "--format", "json"
        ]
        stdout: StdioCollector {
            id: usageStdout
            onStreamFinished: {
                root.receivedOutput = true
                root.loading = false
                root.parseOutput(text)
            }
        }
        stderr: StdioCollector {
            id: usageStderr
        }
        onExited: (exitCode, exitStatus) => {
            root.loading = false
            if (exitCode !== 0) {
                var detail = usageStderr.text.trim()
                root.errorMessage = detail.length > 0
                    ? detail
                    : "Codex usage refresh failed"
            }
        }
        onRunningChanged: {
            if (!running && root.loading && !root.receivedOutput) {
                root.loading = false
                root.binaryMissing = true
                root.errorMessage = "Could not start CodexBar"
            }
        }
    }

    Timer {
        interval: 60000
        running: true
        repeat: true
        onTriggered: {
            root.nowMs = Date.now()
            root.refresh()
        }
    }

    Component.onCompleted: refresh()
}
