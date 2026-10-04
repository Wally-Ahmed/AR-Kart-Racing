# Exactly ONE drive backend is compiled. Both implement the same drive.h contract
# (drive_init / drive_apply / drive_all_off / drive_current_duty), so arkart_main.c and
# control_udp.c are identical either way.
#   Plan M  (CONFIG_ARKART_DRIVE_BACKEND_PWM)      -> drive.c       PWM + kit transistors
#   Plan RX (CONFIG_ARKART_DRIVE_BACKEND_RXINJECT) -> rx_inject.c   inject into the stock board
#
# ir_tag.c (the T3 TV-remote-style 38 kHz IR tag) rides with BOTH backends: its two pins,
# GPIO14 (IR LED) and GPIO3 (TSSP77038 OUT), are free under Plan M (47 / 41 / 42 / 48) and
# under Plan RX (47 / 39..42 / 48) alike — see ir_tag_pins.h.
set(arkart_srcs
    "arkart_main.c"
    "wifi_sta.c"
    "camera_stream.c"
    "control_udp.c"
    "status_led.c"
    "ir_tag.c"
)

if(CONFIG_ARKART_DRIVE_BACKEND_RXINJECT)
    list(APPEND arkart_srcs "rx_inject.c")
    # btn_remote.c taps the STOCK REMOTE's four buttons on GPIO39/40/41/42. It rides with
    # Plan RX and never with Plan M, because under Plan M drive.c owns GPIO41/42 as the
    # steer-coil H-bridge (motor_map.h) — the two must never be in one image.
    list(APPEND arkart_srcs "btn_remote.c")
    # net_drive.c is the NET DRIVE LAYER for the button tap: it turns the car bridge's 8-byte
    # control packet into the set of remote buttons btn_remote.c should hold. It rides with
    # btn_remote.c for the same reason — under Plan M those pads are the steer-coil H-bridge.
    list(APPEND arkart_srcs "net_drive.c")
    if(CONFIG_ARKART_RXINJECT_CONSOLE)
        list(APPEND arkart_srcs "rx_console.c")
    endif()
else()
    list(APPEND arkart_srcs "drive.c")
endif()

idf_component_register(
    SRCS
        ${arkart_srcs}
    INCLUDE_DIRS
        "."
    REQUIRES
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        esp_http_server
        esp_http_client
        nvs_flash
        lwip
        driver
)
