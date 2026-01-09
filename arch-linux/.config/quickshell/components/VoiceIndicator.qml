import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

Item {
    id: voiceIndicator

    property bool recording: false
    property string pidFile: "/tmp/arch-whisper.pid"

    // Check if PID file exists using test command
    Process {
        id: checkProcess
        command: ["test", "-f", pidFile]
        onExited: function(exitCode, exitStatus) {
            voiceIndicator.recording = (exitCode === 0)
        }
    }

    // Poll for file existence
    Timer {
        interval: 200
        running: true
        repeat: true
        onTriggered: {
            checkProcess.running = true
        }
    }

    // Floating overlay panel at bottom center
    PanelWindow {
        id: overlayPanel
        visible: recording

        // Don't reserve space - float on top
        exclusionMode: ExclusionMode.Ignore

        anchors {
            bottom: true
            left: true
            right: true
        }

        margins {
            bottom: 50
        }

        implicitHeight: 40

        color: "transparent"

        // Centered container
        Rectangle {
            id: container
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.verticalCenter: parent.verticalCenter
            width: indicatorRow.width + 24
            height: 32
            color: "#1a1b26"
            border.color: "#3b4261"
            border.width: 1
            radius: 16

            RowLayout {
                id: indicatorRow
                anchors.centerIn: parent
                spacing: 4

                // Animated bars
                Repeater {
                    model: 7
                    Rectangle {
                        width: 3
                        height: 8
                        color: "#c0caf5"
                        radius: 1

                        SequentialAnimation on height {
                            running: recording
                            loops: Animation.Infinite
                            NumberAnimation {
                                to: 8 + Math.random() * 12
                                duration: 120 + index * 40
                                easing.type: Easing.InOutQuad
                            }
                            NumberAnimation {
                                to: 4
                                duration: 120 + index * 40
                                easing.type: Easing.InOutQuad
                            }
                        }
                    }
                }
            }
        }
    }
}
