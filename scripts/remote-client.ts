/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added CLI entrypoint for the OSHAL remote-client daemon
 */

import { createChildLogger } from '@/shared/logger';
import { loadRemoteClientConfig, RemoteClientService } from '@/features/remote-client';

const logger = createChildLogger({ module: 'remote-client-cli' });

/**
 * @description Boots the remote-client daemon.
 */
async function main(): Promise<void> {
  const config = loadRemoteClientConfig(process.env);
  const service = new RemoteClientService(config);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal, clientId: config.clientId }, 'Remote-client shutdown requested');
    await service.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await service.start();
  logger.info(
    {
      clientId: config.clientId,
      controlPlaneUrl: config.controlPlaneUrl,
      mcpCommand: config.mcpCommand,
      polling: !config.disablePolling,
    },
    'Remote-client daemon running',
  );
}

main().catch((error) => {
  logger.error({ err: error }, 'Remote-client startup failed');
  process.exit(1);
});
