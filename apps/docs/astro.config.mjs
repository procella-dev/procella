import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: process.env.SITE_URL || 'https://docs.procella.dev',
  base: '/',
  integrations: [
    starlight({
      title: 'Procella',
      description: 'Self-hosted Pulumi backend documentation',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/procella-dev/procella' },
      ],
      editLink: {
        baseUrl: 'https://github.com/procella-dev/procella/edit/main/apps/docs/',
      },
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Quick Start', slug: 'getting-started/quickstart' },
            { label: 'Configuration', slug: 'getting-started/configuration' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', slug: 'architecture/overview' },
            { label: 'Authentication', slug: 'architecture/authentication' },
            { label: 'Web Dashboard', slug: 'architecture/dashboard' },
            { label: 'Update Lifecycle', slug: 'architecture/update-lifecycle' },
            { label: 'State Operations', slug: 'architecture/state-operations' },
            { label: 'Encryption', slug: 'architecture/encryption' },
            { label: 'Database Schema', slug: 'architecture/database' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'Descope Setup', slug: 'operations/descope' },
            { label: 'Docker Compose', slug: 'operations/docker-compose' },
            { label: 'Horizontal Scaling', slug: 'operations/horizontal-scaling' },
            { label: 'Blob Storage', slug: 'operations/blob-storage' },
            { label: 'Environment Variables', slug: 'operations/environment-variables' },
          ],
        },
        {
          label: 'Development',
          items: [
            { label: 'Contributing', slug: 'development/contributing' },
            { label: 'Testing', slug: 'development/testing' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'Stack API', slug: 'api/stacks' },
            { label: 'Update API', slug: 'api/updates' },
            { label: 'State Operations API', slug: 'api/state' },
            { label: 'Encryption API', slug: 'api/encryption' },
          ],
        },
      ],
    }),
  ],
});
