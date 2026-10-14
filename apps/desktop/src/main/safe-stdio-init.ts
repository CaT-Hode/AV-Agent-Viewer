import { guardStandardPipes } from './safe-stdio';

// This side-effect import must precede Electron/service imports in main.
guardStandardPipes();
