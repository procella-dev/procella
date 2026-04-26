package awslogin

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	ststypes "github.com/aws/aws-sdk-go-v2/service/sts/types"
	"github.com/pulumi/esc"
)

type fakeSTSClient struct {
	output *sts.AssumeRoleWithWebIdentityOutput
	err    error
	input  *sts.AssumeRoleWithWebIdentityInput
}

func (f *fakeSTSClient) AssumeRoleWithWebIdentity(_ context.Context, input *sts.AssumeRoleWithWebIdentityInput, _ ...func(*sts.Options)) (*sts.AssumeRoleWithWebIdentityOutput, error) {
	f.input = input
	if f.err != nil {
		return nil, f.err
	}
	return f.output, nil
}

func TestOpenStaticPassesThroughCredentials(t *testing.T) {
	p := New().(*provider)
	v, err := p.Open(context.Background(), map[string]esc.Value{
		"region": esc.NewValue("us-east-1"),
		"static": esc.NewValue(map[string]esc.Value{
			"accessKeyId":     esc.NewValue("AKIA123"),
			"secretAccessKey": esc.NewValue("secret"),
			"sessionToken":    esc.NewValue("token"),
		}),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	got := v.Value.(map[string]esc.Value)
	if got["region"].Value != "us-east-1" {
		t.Fatalf("region = %v, want us-east-1", got["region"].Value)
	}
	if !got["accessKeyId"].Secret || got["accessKeyId"].Value != "AKIA123" {
		t.Fatalf("accessKeyId = %#v", got["accessKeyId"])
	}
}

func TestOpenOIDCAssumesRoleWithWebIdentity(t *testing.T) {
	client := &fakeSTSClient{output: &sts.AssumeRoleWithWebIdentityOutput{Credentials: &ststypes.Credentials{
		AccessKeyId:     aws.String("AKIAOIDC"),
		SecretAccessKey: aws.String("secret"),
		SessionToken:    aws.String("session"),
		Expiration:      aws.Time(time.Date(2026, 4, 23, 12, 0, 0, 0, time.UTC)),
	}}}
	p := New(
		WithConfigLoader(func(_ context.Context, region string) (aws.Config, error) { return aws.Config{Region: region}, nil }),
		WithSTSClientFactory(func(aws.Config) stsAPI { return client }),
		WithFileReader(func(string) ([]byte, error) { return []byte("jwt-token"), nil }),
	).(*provider)
	t.Setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/tmp/token")

	v, err := p.Open(context.Background(), map[string]esc.Value{
		"region": esc.NewValue("us-west-2"),
		"oidc": esc.NewValue(map[string]esc.Value{
			"roleArn":     esc.NewValue("arn:aws:iam::123456789012:role/demo"),
			"sessionName": esc.NewValue("procella-test"),
			"duration":    esc.NewValue("1h"),
			"policyArns": esc.NewValue([]esc.Value{
				esc.NewValue("arn:aws:iam::aws:policy/ReadOnlyAccess"),
			}),
		}),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	if client.input == nil || aws.ToString(client.input.RoleArn) != "arn:aws:iam::123456789012:role/demo" {
		t.Fatalf("unexpected sts input: %#v", client.input)
	}
	if got := v.Value.(map[string]esc.Value)["accessKeyId"]; !got.Secret || got.Value != "AKIAOIDC" {
		t.Fatalf("accessKeyId = %#v", got)
	}
	if got := v.Value.(map[string]esc.Value)["region"].Value; got != "us-west-2" {
		t.Fatalf("region = %v, want us-west-2", got)
	}
}

func TestOpenRejectsMissingAuthMode(t *testing.T) {
	_, err := New().Open(context.Background(), map[string]esc.Value{}, nil)
	if err == nil || !strings.Contains(err.Error(), "exactly one of oidc or static") {
		t.Fatalf("expected missing auth mode error, got %v", err)
	}
}

func TestOpenPropagatesSTSError(t *testing.T) {
	want := errors.New("boom")
	p := New(
		WithConfigLoader(func(_ context.Context, region string) (aws.Config, error) { return aws.Config{Region: region}, nil }),
		WithSTSClientFactory(func(aws.Config) stsAPI { return &fakeSTSClient{err: want} }),
		WithFileReader(func(string) ([]byte, error) { return []byte("jwt-token"), nil }),
	).(*provider)
	t.Setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/tmp/token")

	_, err := p.Open(context.Background(), map[string]esc.Value{
		"oidc": esc.NewValue(map[string]esc.Value{
			"roleArn":     esc.NewValue("arn:aws:iam::123456789012:role/demo"),
			"sessionName": esc.NewValue("procella-test"),
		}),
	}, nil)
	if !errors.Is(err, want) {
		t.Fatalf("expected wrapped sts error, got %v", err)
	}
}
