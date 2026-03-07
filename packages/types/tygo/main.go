// This file exists solely to import the Pulumi SDK apitype package
// so that `go mod tidy` resolves all transitive dependencies needed
// by tygo to generate TypeScript types.
//
// Usage: cd packages/types/tygo && tygo generate
package main

import _ "github.com/pulumi/pulumi/sdk/v3/go/common/apitype"

func main() {}
