import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import Quickshell

Item {
    id: clock
    implicitWidth: timeLayout.implicitWidth
    implicitHeight: 24

    property bool showCalendar: false

    RowLayout {
        id: timeLayout
        anchors.fill: parent
        spacing: 5

        Text {
            id: timeText
            text: Qt.formatDateTime(new Date(), "hh:mm")
            color: mouseArea.containsMouse ? "#ff9e64" : "#c0caf5"
            font.pixelSize: 14
            font.bold: true
            Layout.fillHeight: true
            Layout.bottomMargin: 2
            verticalAlignment: Text.AlignVCenter
        }

        Text {
            id: dateText
            text: Qt.formatDateTime(new Date(), "MMM d")
            color: mouseArea.containsMouse ? "#ff9e64" : "#7aa2f7"
            font.pixelSize: 14
            Layout.fillHeight: true
            Layout.bottomMargin: 2
            verticalAlignment: Text.AlignVCenter
        }
    }

    MouseArea {
        id: mouseArea
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
    }

    PanelWindow {
        id: calendarWindow
        visible: mouseArea.containsMouse
        
        // Ensure it's on top of everything
        aboveWindows: true
        
        anchors {
            top: true
            right: true
        }

        margins {
            top: 40
            right: 10
        }
        
        width: 220
        height: 260
        
        color: "transparent"

        Rectangle {
            anchors.fill: parent
            color: "#1a1b26"
            border.color: "#7aa2f7"
            border.width: 1
            radius: 8
            
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 10
                spacing: 5
                
                Text {
                    text: Qt.formatDateTime(new Date(), "MMMM yyyy")
                    color: "#7aa2f7"
                    font.bold: true
                    Layout.alignment: Qt.AlignHCenter
                }

                DayOfWeekRow {
                    locale: monthGrid.locale
                    Layout.fillWidth: true
                    delegate: Text {
                        text: model.shortName
                        color: "#565f89"
                        font.pixelSize: 10
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                    }
                }

                MonthGrid {
                    id: monthGrid
                    month: new Date().getMonth()
                    year: new Date().getFullYear()
                    locale: Qt.locale("en_US")
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    
                    delegate: Text {
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                        opacity: model.month === monthGrid.month ? 1 : 0.3
                        text: model.day
                        color: model.today ? "#ff9e64" : (model.month === monthGrid.month ? "#c0caf5" : "#565f89")
                        font.bold: model.today
                        
                        Rectangle {
                            anchors.fill: parent
                            anchors.margins: -2
                            color: "#7aa2f7"
                            opacity: 0.2
                            visible: model.today
                            radius: 4
                            z: -1
                        }
                    }
                }
            }
        }
    }

    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: {
            var date = new Date();
            timeText.text = Qt.formatDateTime(date, "hh:mm");
            dateText.text = Qt.formatDateTime(date, "MMM d");
        }
    }
}
