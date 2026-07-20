import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

PopupButton {
    id: barSettings
    icon: "󰒓"
    popupWidth: 250
    popupRightMargin: 12

    property string outputName: ""
    property real barScale: 1.0

    readonly property string settingsPath: Quickshell.statePath("bar-scales.json")

    // Read saved scale on startup
    Process {
        id: readSettings
        command: ["bash", "-c", "if [[ -r \"$1\" ]]; then < \"$1\"; else printf '{}'; fi", "bash", barSettings.settingsPath]
        running: true
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    var settings = JSON.parse(text);
                    if (settings[barSettings.outputName] !== undefined) {
                        barSettings.barScale = settings[barSettings.outputName];
                    }
                } catch (e) {}
            }
        }
    }

    Process {
        id: saveProc
    }

    function saveScale() {
        saveProc.command = ["python3", "-c",
            "import json,sys,os\n" +
            "p=sys.argv[1];k=sys.argv[2];v=float(sys.argv[3])\n" +
            "d={}\n" +
            "try:\n" +
            " with open(p) as f: d=json.load(f)\n" +
            "except: pass\n" +
            "d[k]=v\n" +
            "os.makedirs(os.path.dirname(p),exist_ok=True)\n" +
            "with open(p,'w') as f: json.dump(d,f)\n",
            settingsPath, outputName, barScale.toFixed(2)
        ];
        saveProc.running = true;
    }

    // Popup content
    ColumnLayout {
        width: parent ? parent.width : 218
        spacing: 12

        Text {
            text: "Bar Settings"
            font.pixelSize: 14
            font.bold: true
            color: "#c0caf5"
        }

        Text {
            text: barSettings.outputName
            font.pixelSize: 11
            color: "#565f89"
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
                spacing: 10
                Text {
                    text: "Scale"
                    font.pixelSize: 14
                    color: "#c0caf5"
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: Math.round(barSettings.barScale * 100) + "%"
                    font.pixelSize: 13
                    color: "#565f89"
                }
            }

            Item {
                id: scaleSliderItem
                Layout.fillWidth: true
                height: 24

                property real minScale: 0.5
                property real maxScale: 2.0
                property real range: maxScale - minScale

                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: parent.width
                    height: 6
                    radius: 3
                    color: "#363b54"

                    Rectangle {
                        width: ((barSettings.barScale - scaleSliderItem.minScale) / scaleSliderItem.range) * parent.width
                        height: parent.height
                        color: "#9ece6a"
                        radius: 3
                    }
                }

                Rectangle {
                    x: ((barSettings.barScale - scaleSliderItem.minScale) / scaleSliderItem.range) * (parent.width - width)
                    anchors.verticalCenter: parent.verticalCenter
                    width: 18
                    height: 18
                    radius: 9
                    color: scaleMouseArea.pressed ? "#b9f27c" : "#9ece6a"
                }

                MouseArea {
                    id: scaleMouseArea
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onPressed: (mouse) => updateScale(mouse.x)
                    onPositionChanged: (mouse) => { if (pressed) updateScale(mouse.x) }
                    onReleased: barSettings.saveScale()
                    function updateScale(mouseX) {
                        var normalized = Math.max(0, Math.min(1, mouseX / width));
                        var newScale = scaleSliderItem.minScale + normalized * scaleSliderItem.range;
                        newScale = Math.round(newScale * 20) / 20;
                        barSettings.barScale = newScale;
                    }
                }
            }
        }
    }
}
