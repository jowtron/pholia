package main

import (
	"io"
	"net/http"
	"strings"
)

type ProxyHandler struct {
	client *http.Client
}

func NewProxyHandler() *ProxyHandler {
	return &ProxyHandler{client: &http.Client{}}
}

func (p *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/proxy/") {
		http.NotFound(w, r)
		return
	}

	// Path format: /proxy/{scheme}/{host}/{rest...}
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

	for _, key := range []string{"Content-Type", "Accept"} {
		if val := r.Header.Get(key); val != "" {
			proxyReq.Header.Set(key, val)
		}
	}

	resp, err := p.client.Do(proxyReq)
	if err != nil {
		http.Error(w, "Upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for key, vals := range resp.Header {
		for _, val := range vals {
			w.Header().Add(key, val)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
