import QtQuick
import QtQuick.Layouts

PopupButton {
    id: codexUsage

    visible: !usageModel.binaryMissing
    icon: "󰚩"
    label: loading && primaryPercent < 0 && secondaryPercent < 0
        ? "…"
        : (primaryPercent >= 0 && secondaryPercent >= 0
            ? primaryPercent + "% · " + secondaryPercent + "%"
            : (primaryPercent >= 0
                ? "S " + primaryPercent + "%"
                : (secondaryPercent >= 0 ? "W " + secondaryPercent + "%" : "--")))
    foregroundColor: errorMessage.length > 0
        ? "#f7768e"
        : (highestPercent >= 90
            ? "#f7768e"
            : (highestPercent >= 70 ? "#ff9e64" : "#9ece6a"))
    popupWidth: 310
    popupRightMargin: 160

    required property var usageModel

    readonly property int primaryPercent: usageModel.primaryPercent
    readonly property int secondaryPercent: usageModel.secondaryPercent
    readonly property string primaryResetAt: usageModel.primaryResetAt
    readonly property string secondaryResetAt: usageModel.secondaryResetAt
    readonly property string primaryPace: usageModel.primaryPace
    readonly property string secondaryPace: usageModel.secondaryPace
    readonly property string accountEmail: usageModel.accountEmail
    readonly property string loginMethod: usageModel.loginMethod
    readonly property string sourceName: usageModel.sourceName
    readonly property real creditsRemaining: usageModel.creditsRemaining
    readonly property string updatedAt: usageModel.updatedAt
    readonly property string errorMessage: usageModel.errorMessage
    readonly property bool loading: usageModel.loading
    readonly property double nowMs: usageModel.nowMs

    readonly property int highestPercent: Math.max(primaryPercent, secondaryPercent)

    function refresh() {
        usageModel.refresh()
    }

    function resetLabel(value) {
        if (!value)
            return "Reset unavailable"

        var resetMs = Date.parse(value)
        if (isNaN(resetMs))
            return value

        var remainingMinutes = Math.max(0, Math.ceil((resetMs - nowMs) / 60000))
        if (remainingMinutes === 0)
            return "Resetting now"

        var days = Math.floor(remainingMinutes / 1440)
        var hours = Math.floor((remainingMinutes % 1440) / 60)
        var minutes = remainingMinutes % 60

        if (days > 0)
            return "Resets in " + days + "d " + hours + "h"
        if (hours > 0)
            return "Resets in " + hours + "h " + minutes + "m"
        return "Resets in " + minutes + "m"
    }

    function updatedLabel() {
        if (loading)
            return "Refreshing…"
        if (!updatedAt)
            return "Not updated"

        var ageMinutes = Math.max(0, Math.floor((nowMs - Date.parse(updatedAt)) / 60000))
        if (ageMinutes < 1)
            return "Updated now"
        if (ageMinutes === 1)
            return "Updated 1 minute ago"
        return "Updated " + ageMinutes + " minutes ago"
    }

    function paceLabel(value) {
        return String(value || "").split("|")[0].trim()
    }

    ColumnLayout {
        width: parent ? parent.width : 278
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Text {
                text: "Codex"
                font.pixelSize: 15
                font.bold: true
                color: "#c0caf5"
            }

            Item {
                Layout.fillWidth: true
            }

            Text {
                text: codexUsage.updatedLabel()
                font.pixelSize: 11
                color: "#565f89"
            }

            Rectangle {
                width: 24
                height: 24
                radius: 4
                color: refreshMouseArea.containsMouse ? "#363b54" : "transparent"

                Text {
                    anchors.centerIn: parent
                    text: "󰑐"
                    font.family: "Symbols Nerd Font"
                    font.pixelSize: 14
                    color: codexUsage.loading ? "#565f89" : "#7aa2f7"
                }

                MouseArea {
                    id: refreshMouseArea
                    anchors.fill: parent
                    enabled: !codexUsage.loading
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: codexUsage.refresh()
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            height: 1
            color: "#363b54"
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            RowLayout {
                Layout.fillWidth: true

                Text {
                    text: "Session"
                    font.pixelSize: 13
                    color: "#c0caf5"
                }

                Item {
                    Layout.fillWidth: true
                }

                Text {
                    text: codexUsage.primaryPercent < 0 ? "Unavailable" : codexUsage.primaryPercent + "% used"
                    font.pixelSize: 12
                    font.bold: true
                    color: codexUsage.primaryPercent >= 90
                        ? "#f7768e"
                        : (codexUsage.primaryPercent >= 70 ? "#ff9e64" : "#9ece6a")
                }
            }

            Rectangle {
                Layout.fillWidth: true
                height: 5
                radius: 3
                color: "#363b54"

                Rectangle {
                    width: parent.width * Math.max(0, codexUsage.primaryPercent) / 100
                    height: parent.height
                    radius: parent.radius
                    color: codexUsage.primaryPercent >= 90
                        ? "#f7768e"
                        : (codexUsage.primaryPercent >= 70 ? "#ff9e64" : "#9ece6a")
                }
            }

            RowLayout {
                Layout.fillWidth: true

                Text {
                    text: codexUsage.resetLabel(codexUsage.primaryResetAt)
                    font.pixelSize: 11
                    color: "#565f89"
                }

                Item {
                    Layout.fillWidth: true
                }

                Text {
                    visible: codexUsage.primaryPace.length > 0
                    text: codexUsage.paceLabel(codexUsage.primaryPace)
                    font.pixelSize: 10
                    color: "#565f89"
                }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            RowLayout {
                Layout.fillWidth: true

                Text {
                    text: "Weekly"
                    font.pixelSize: 13
                    color: "#c0caf5"
                }

                Item {
                    Layout.fillWidth: true
                }

                Text {
                    text: codexUsage.secondaryPercent < 0 ? "Unavailable" : codexUsage.secondaryPercent + "% used"
                    font.pixelSize: 12
                    font.bold: true
                    color: codexUsage.secondaryPercent >= 90
                        ? "#f7768e"
                        : (codexUsage.secondaryPercent >= 70 ? "#ff9e64" : "#7aa2f7")
                }
            }

            Rectangle {
                Layout.fillWidth: true
                height: 5
                radius: 3
                color: "#363b54"

                Rectangle {
                    width: parent.width * Math.max(0, codexUsage.secondaryPercent) / 100
                    height: parent.height
                    radius: parent.radius
                    color: codexUsage.secondaryPercent >= 90
                        ? "#f7768e"
                        : (codexUsage.secondaryPercent >= 70 ? "#ff9e64" : "#7aa2f7")
                }
            }

            RowLayout {
                Layout.fillWidth: true

                Text {
                    text: codexUsage.resetLabel(codexUsage.secondaryResetAt)
                    font.pixelSize: 11
                    color: "#565f89"
                }

                Item {
                    Layout.fillWidth: true
                }

                Text {
                    visible: codexUsage.secondaryPace.length > 0
                    text: codexUsage.paceLabel(codexUsage.secondaryPace)
                    font.pixelSize: 10
                    color: "#565f89"
                }
            }
        }

        Rectangle {
            visible: codexUsage.creditsRemaining >= 0
            Layout.fillWidth: true
            height: 1
            color: "#363b54"
        }

        RowLayout {
            visible: codexUsage.creditsRemaining >= 0
            Layout.fillWidth: true

            Text {
                text: "Credits"
                font.pixelSize: 12
                color: "#565f89"
            }

            Item {
                Layout.fillWidth: true
            }

            Text {
                text: codexUsage.creditsRemaining.toFixed(1) + " remaining"
                font.pixelSize: 12
                color: "#c0caf5"
            }
        }

        Text {
            visible: codexUsage.errorMessage.length > 0
            Layout.fillWidth: true
            text: codexUsage.errorMessage
            wrapMode: Text.Wrap
            font.pixelSize: 11
            color: "#f7768e"
        }

        Text {
            visible: codexUsage.errorMessage.length === 0
            Layout.fillWidth: true
            text: [codexUsage.accountEmail, codexUsage.loginMethod, codexUsage.sourceName]
                .filter(value => value && value.length > 0)
                .join(" · ")
            elide: Text.ElideMiddle
            font.pixelSize: 10
            color: "#565f89"
        }
    }
}
