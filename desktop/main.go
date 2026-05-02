package main

import (
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	frontendFS, err := fs.Sub(assets, "frontend")
	if err != nil {
		log.Fatal(err)
	}

	app := NewApp()

	err = wails.Run(&options.App{
		Title:  "Pholia",
		Width:  1200,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets:  frontendFS,
			Handler: NewProxyHandler(),
		},
		BackgroundColour: &options.RGBA{R: 18, G: 18, B: 18, A: 255},
		Mac: &mac.Options{
			About: &mac.AboutInfo{
				Title:   "Pholia",
				Message: "Audiobookshelf Client",
			},
		},
		OnStartup: app.startup,
		Bind:      []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}
