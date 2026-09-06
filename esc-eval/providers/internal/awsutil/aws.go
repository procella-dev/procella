package awsutil

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/pulumi/esc"
	"github.com/tektum/procella/esc-eval/providers/internal/escutil"
)

type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

type ConfigLoader func(ctx context.Context, region string, creds Credentials) (aws.Config, error)

func DefaultConfigLoader(ctx context.Context, region string, creds Credentials) (aws.Config, error) {
	provider := credentials.NewStaticCredentialsProvider(creds.AccessKeyID, creds.SecretAccessKey, creds.SessionToken)
	options := []func(*config.LoadOptions) error{config.WithCredentialsProvider(provider)}
	if region != "" {
		options = append(options, config.WithRegion(region))
	}
	return config.LoadDefaultConfig(ctx, options...)
}

func RequiredLogin(inputs map[string]esc.Value) (Credentials, error) {
	login, err := escutil.RequiredObject(inputs, "login")
	if err != nil {
		return Credentials{}, err
	}
	accessKeyID, err := escutil.RequiredString(login, "accessKeyId")
	if err != nil {
		return Credentials{}, err
	}
	secretAccessKey, err := escutil.RequiredString(login, "secretAccessKey")
	if err != nil {
		return Credentials{}, err
	}
	sessionToken, _, err := escutil.OptionalString(login, "sessionToken")
	if err != nil {
		return Credentials{}, err
	}

	return Credentials{
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		SessionToken:    sessionToken,
	}, nil
}
