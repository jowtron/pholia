package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

void setAppIcon(const void* data, int len) {
    NSData *imageData = [NSData dataWithBytes:data length:len];
    NSImage *image = [[NSImage alloc] initWithData:imageData];
    if (image) {
        [NSApp setApplicationIconImage:image];
    }
}

int isDarkMode() {
    if (@available(macOS 10.14, *)) {
        NSAppearanceName appearance = [[NSApp effectiveAppearance] bestMatchFromAppearancesWithNames:@[
            NSAppearanceNameAqua, NSAppearanceNameDarkAqua
        ]];
        return [appearance isEqualToString:NSAppearanceNameDarkAqua] ? 1 : 0;
    }
    return 0;
}
*/
import "C"

import (
	_ "embed"
	"unsafe"
)

//go:embed icons/light.png
var iconLight []byte

//go:embed icons/dark.png
var iconDark []byte

func setDockIcon() {
	var icon []byte
	if C.isDarkMode() == 1 {
		icon = iconDark
	} else {
		icon = iconLight
	}
	C.setAppIcon(unsafe.Pointer(&icon[0]), C.int(len(icon)))
}
