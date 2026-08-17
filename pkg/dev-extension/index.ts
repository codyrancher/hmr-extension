import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import routes from './routing';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  plugin.addRoutes(routes);

  // The product module is passed whole, not its init function: addProduct treats any
  // argument with a truthy `.name` as the newer metadata API, and a named function has one.
  plugin.addProduct(require('./product'));
}
