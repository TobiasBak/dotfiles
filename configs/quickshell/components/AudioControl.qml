import QtQuick
import QtQuick.Layouts
import Quickshell.Services.Pipewire

PopupButton {
    id: audioControl

    property var outputAudio: Pipewire.defaultAudioSink ? Pipewire.defaultAudioSink.audio : null
    property var inputAudio: Pipewire.defaultAudioSource ? Pipewire.defaultAudioSource.audio : null
    property real outputVolume: outputAudio ? outputAudio.volume : 0.0
    property real inputVolume: inputAudio ? inputAudio.volume : 0.0
    property bool outputMuted: outputAudio ? outputAudio.muted : false

    icon: outputMuted ? "󰖁" : (outputVolume > 0.5 ? "󰕾" : (outputVolume > 0 ? "󰖀" : "󰕿"))
    popupWidth: 280
    popupRightMargin: 80

    PwObjectTracker {
        objects: [Pipewire.defaultAudioSink, Pipewire.defaultAudioSource]
    }

    ColumnLayout {
        width: parent ? parent.width : 248
        spacing: 16

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            RowLayout {
                spacing: 10
                Text {
                    text: "󰕾"
                    font.family: "Symbols Nerd Font"
                    font.pixelSize: 18
                    color: "#7aa2f7"
                }
                Text {
                    text: "Output"
                    font.pixelSize: 14
                    color: "#c0caf5"
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: Math.round(audioControl.outputVolume * 100) + "%"
                    font.pixelSize: 13
                    color: "#565f89"
                }
            }

            Item {
                id: outputSliderItem
                Layout.fillWidth: true
                height: 24

                property real displayValue: audioControl.outputVolume

                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: parent.width
                    height: 6
                    radius: 3
                    color: "#363b54"

                    Rectangle {
                        width: Math.min(outputSliderItem.displayValue / 1.5, 1.0) * parent.width
                        height: parent.height
                        color: "#7aa2f7"
                        radius: 3
                    }
                }

                Rectangle {
                    x: Math.min(outputSliderItem.displayValue / 1.5, 1.0) * (parent.width - width)
                    anchors.verticalCenter: parent.verticalCenter
                    width: 18
                    height: 18
                    radius: 9
                    color: outputMouseArea.pressed ? "#89b4fa" : "#7aa2f7"
                }

                MouseArea {
                    id: outputMouseArea
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onPressed: mouse => updateOutputVolume(mouse.x)
                    onPositionChanged: mouse => {
                        if (pressed) updateOutputVolume(mouse.x)
                    }
                    onReleased: outputSliderItem.displayValue = Qt.binding(() => audioControl.outputVolume)

                    function updateOutputVolume(mouseX) {
                        var newVolume = Math.max(0, Math.min(1.5, (mouseX / width) * 1.5))
                        outputSliderItem.displayValue = newVolume
                        if (audioControl.outputAudio) audioControl.outputAudio.volume = newVolume
                    }
                }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            RowLayout {
                spacing: 10
                Text {
                    text: "󰍬"
                    font.family: "Symbols Nerd Font"
                    font.pixelSize: 18
                    color: "#f7768e"
                }
                Text {
                    text: "Microphone"
                    font.pixelSize: 14
                    color: "#c0caf5"
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: Math.round(audioControl.inputVolume * 100) + "%"
                    font.pixelSize: 13
                    color: "#565f89"
                }
            }

            Item {
                id: inputSliderItem
                Layout.fillWidth: true
                height: 24

                property real displayValue: audioControl.inputVolume

                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: parent.width
                    height: 6
                    radius: 3
                    color: "#363b54"

                    Rectangle {
                        width: Math.min(inputSliderItem.displayValue / 1.5, 1.0) * parent.width
                        height: parent.height
                        color: "#f7768e"
                        radius: 3
                    }
                }

                Rectangle {
                    x: Math.min(inputSliderItem.displayValue / 1.5, 1.0) * (parent.width - width)
                    anchors.verticalCenter: parent.verticalCenter
                    width: 18
                    height: 18
                    radius: 9
                    color: inputMouseArea.pressed ? "#ffa0b4" : "#f7768e"
                }

                MouseArea {
                    id: inputMouseArea
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onPressed: mouse => updateInputVolume(mouse.x)
                    onPositionChanged: mouse => {
                        if (pressed) updateInputVolume(mouse.x)
                    }
                    onReleased: inputSliderItem.displayValue = Qt.binding(() => audioControl.inputVolume)

                    function updateInputVolume(mouseX) {
                        var newVolume = Math.max(0, Math.min(1.5, (mouseX / width) * 1.5))
                        inputSliderItem.displayValue = newVolume
                        if (audioControl.inputAudio) audioControl.inputAudio.volume = newVolume
                    }
                }
            }
        }
    }
}
