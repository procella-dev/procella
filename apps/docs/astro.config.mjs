import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const isProd = process.env.NODE_ENV === 'production';

export default defineConfig({
  site: 'https://strata-iac.github.io',
  base: isProd ? '/strata' : '/docs',
  integrations: [
    starlight({
      title: 'Strata',
      description: 'Self-hosted Pulumi backend documentation',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/strata-iac/strata' },
      ],
      editLink: {
        baseUrl: 'https://github.com/strata-iac/strata/edit/main/docs/',
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
