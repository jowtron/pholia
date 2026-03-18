package main

import (
	"io"
	"log"
	"net/http"
	"strings"
)

func main() {
	// Serve static files
	fs := http.FileServer(http.Dir("."))

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Proxy requests to /proxy/* to the target server
		if strings.HasPrefix(r.URL.Path, "/proxy/") {
			proxyHandler(w, r)
			return
		}
		fs.ServeHTTP(w, r)
	})

	log.Println("Cadence running at http://localhost:8090")
	log.Fatal(http.ListenAndServe(":8090", nil))
}

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	// Path format: /proxy/{scheme}/{host}/{rest...}
	// e.g. /proxy/https/abs.example.com/login
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/proxy/"), "/", 3)
	if len(parts) < 2 {
		http.Error(w, "Invalid proxy path", http.StatusBadRequest)
		return
	}

	scheme := parts[0]
	host := parts[1]
	path := ""
	if len(parts) == 3 {
		path = parts[2]
	}

	targetURL := scheme + "://" + host + "/" + path
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	proxyReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	// Copy relevant headers
	for _, key := range []string{"Authorization", "Content-Type", "Accept"} {
		if val := r.Header.Get(key); val != "" {
			proxyReq.Header.Set(key, val)
		}
	}

	resp, err := http.DefaultClient.Do(proxyReq)
	if err != nil {
		http.Error(w, "Upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for key, vals := range resp.Header {
		for _, val := range vals {
			w.Header().Add(key, val)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
