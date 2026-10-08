package auth

import (
	"bytes"
	"testing"
)

func TestSealDoesNotStorePlainTokenAndRejectsTampering(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	token := []byte("device-secret-token")
	sealed, err := Seal(key, token)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains([]byte(sealed), token) {
		t.Fatal("encrypted value contains secret")
	}
	opened, err := Open(key, sealed)
	if err != nil || !bytes.Equal(token, opened) {
		t.Fatal("cannot recover token")
	}
	altered := []byte(sealed)
	altered[len(altered)/2] = 'A'
	if altered[len(altered)/2] == sealed[len(altered)/2] {
		altered[len(altered)/2] = 'B'
	}
	if _, err := Open(key, string(altered)); err == nil {
		t.Fatal("tampered encrypted token accepted")
	}
}
