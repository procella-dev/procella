package escutil

import (
	"encoding/json"
	"fmt"

	"github.com/pulumi/esc"
)

func RequiredString(inputs map[string]esc.Value, name string) (string, error) {
	v, ok := inputs[name]
	if !ok {
		return "", fmt.Errorf("%s is required", name)
	}
	return StringValue(v, name)
}

func OptionalString(inputs map[string]esc.Value, name string) (string, bool, error) {
	v, ok := inputs[name]
	if !ok {
		return "", false, nil
	}
	s, err := StringValue(v, name)
	if err != nil {
		return "", false, err
	}
	return s, true, nil
}

func OptionalBool(inputs map[string]esc.Value, name string) (bool, bool, error) {
	v, ok := inputs[name]
	if !ok {
		return false, false, nil
	}
	b, ok := v.Value.(bool)
	if !ok {
		return false, false, fmt.Errorf("%s must be a boolean", name)
	}
	return b, true, nil
}

func OptionalInt(inputs map[string]esc.Value, name string) (int64, bool, error) {
	v, ok := inputs[name]
	if !ok {
		return 0, false, nil
	}
	n, ok := v.Value.(json.Number)
	if !ok {
		return 0, false, fmt.Errorf("%s must be a number", name)
	}
	i, err := n.Int64()
	if err != nil {
		return 0, false, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	return i, true, nil
}

func RequiredObject(inputs map[string]esc.Value, name string) (map[string]esc.Value, error) {
	v, ok := inputs[name]
	if !ok {
		return nil, fmt.Errorf("%s is required", name)
	}
	return ObjectValue(v, name)
}

func OptionalObject(inputs map[string]esc.Value, name string) (map[string]esc.Value, bool, error) {
	v, ok := inputs[name]
	if !ok {
		return nil, false, nil
	}
	o, err := ObjectValue(v, name)
	if err != nil {
		return nil, false, err
	}
	return o, true, nil
}

func OptionalStringSlice(inputs map[string]esc.Value, name string) ([]string, bool, error) {
	v, ok := inputs[name]
	if !ok {
		return nil, false, nil
	}
	values, ok := v.Value.([]esc.Value)
	if !ok {
		return nil, false, fmt.Errorf("%s must be an array", name)
	}
	items := make([]string, len(values))
	for i, item := range values {
		s, err := StringValue(item, fmt.Sprintf("%s[%d]", name, i))
		if err != nil {
			return nil, false, err
		}
		items[i] = s
	}
	return items, true, nil
}

func StringValue(v esc.Value, name string) (string, error) {
	s, ok := v.Value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", name)
	}
	if s == "" {
		return "", fmt.Errorf("%s must not be empty", name)
	}
	return s, nil
}

func ObjectValue(v esc.Value, name string) (map[string]esc.Value, error) {
	o, ok := v.Value.(map[string]esc.Value)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", name)
	}
	return o, nil
}

func ToEscValue(v any) (esc.Value, error) {
	return esc.FromJSON(v)
}
