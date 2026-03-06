package updates

import "errors"

var (
	// ErrUpdateNotFound is returned when a referenced update does not exist.
	ErrUpdateNotFound = errors.New("update not found")

	// ErrUpdateConflict is returned when a stack already has an active update.
	ErrUpdateConflict = errors.New("stack already has an active update")

	// ErrInvalidToken is returned when the provided update token is invalid.
	ErrInvalidToken = errors.New("invalid update token")

	// ErrLeaseExpired is returned when the update lease has expired.
	ErrLeaseExpired = errors.New("update lease has expired")

	// ErrStackNotFound is returned when the referenced stack does not exist.
	ErrStackNotFound = errors.New("stack not found")
)
