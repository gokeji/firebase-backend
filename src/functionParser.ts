// functionParser.ts

import cors from 'cors';
import express, { Application, Router } from 'express';
import fileUpload from 'express-fileupload';
import * as functions from 'firebase-functions';
import glob from 'glob';
import { parse, ParsedPath } from 'path';
import { Endpoint, ParserOptions, RequestType } from './models';

// enable short hand for console.log()
const { log } = console;
/**
 * Config for the {@link FunctionParser} constructor
 */ interface FunctionParserOptions {
  rootPath: string;
  exports: any;
  options?: ParserOptions;
  verbose?: boolean;
}
/**
 * This class helps with setting sup the exports for the cloud functions deployment.
 *
 * It takes in exports and then adds the required groups and their functions to it for deployment
 * to the cloud functions server.
 *
 * @export
 * @class FunctionParser
 */
export class FunctionParser {
  rootPath: string;

  enableCors: boolean;

  exports: any;

  verbose: boolean;
  /**
   * Creates an instance of FunctionParser.
   * @param {FunctionParserOptions} [config]
   * @memberof FunctionParser
   */
  constructor(props: FunctionParserOptions) {
    const { rootPath, exports, options, verbose = false } = props;
    if (!rootPath) {
      throw new Error('rootPath is required to find the functions.');
    }

    this.rootPath = rootPath;
    this.exports = exports;
    this.verbose = verbose;
    // Set default option values for if not provided
    this.enableCors = options?.enableCors ?? false;
    let groupByFolder: boolean = options?.groupByFolder ?? true;
    let buildReactive: boolean = options?.buildReactive ?? true;
    let buildEndpoints: boolean = options?.buildEndpoints ?? true;

    if (buildReactive) {
      this.buildReactiveFunctions(groupByFolder);
    }

    if (buildEndpoints) {
      this.buildRestfulApi(groupByFolder);
    }
  }

  /**
   * Looks for all files with .function.js and exports them on the group they belong to
   *
   * @private
   * @param {boolean} groupByFolder
   * @memberof FunctionParser
   */
  private buildReactiveFunctions(groupByFolder: boolean) {
    if (this.verbose) log('Reactive Functions - Building...');

    // Get all the files that has .function in the file name
    const functionFiles: string[] = glob.sync(
      `${this.rootPath}/**/*.function.js`,
      {
        cwd: this.rootPath,
        ignore: './node_modules/**',
      }
    );

    functionFiles.forEach((file: string) => {
      const filePath: ParsedPath = parse(file);

      const directories: string[] = filePath.dir.split('/');

      const groupName: string = groupByFolder
        ? directories[directories.length - 2] || ''
        : directories[directories.length - 1] || '';

      const functionName = filePath.name.replace('.function', '');

      if (
        !process.env.FUNCTION_NAME ||
        process.env.FUNCTION_NAME === functionName
      ) {
        if (!this.exports[groupName]) this.exports[groupName] = {};
        if (this.verbose)
          log(`Reactive Functions - Added ${groupName}/${functionName}`);

        this.exports[groupName] = {
          ...this.exports[groupName],
          ...require(file),
        };
      }
    });
    if (this.verbose) log('Reactive Functions - Built');
  }

  /**
   * Looks at all .endpoint.js files and adds them to the group they belong in
   *
   * @private
   * @param {boolean} groupByFolder
   * @memberof FunctionParser
   */
  private buildRestfulApi(groupByFolder: boolean) {
    if (this.verbose) log('Restful Endpoints - Building...');

    const apiFiles: string[] = glob.sync(`${this.rootPath}/**/*.endpoint.js`, {
      cwd: this.rootPath,
      ignore: './node_modules/**',
    });

    const app: Application = express();

    const groupRouters: Map<string, express.Router> = new Map();

    apiFiles.forEach((file: string) => {
      const filePath: ParsedPath = parse(file);

      const directories: Array<string> = filePath.dir.split('/');

      const groupName: string = groupByFolder
        ? directories[directories.length - 2] || ''
        : directories[directories.length - 1] || '';

      let router: Router | undefined = groupRouters.get(groupName);

      if (!router) {
        router = express.Router();

        groupRouters.set(groupName, router);
      }

      try {
        this.buildEndpoint(file, groupName, router);
      } catch (e) {
        throw new Error(
          `Restful Endpoints - Failed to add the endpoint defined in ${file} to the ${groupName} Api.`
        );
      }

      app.use('/', router);

      this.exports[groupName] = {
        ...this.exports[groupName],
        api: functions.https.onRequest(app),
      };
    });

    if (this.verbose) log('Restful Endpoints - Built');
  }

  /**
   * Parses a .endpoint.js file and sets the endpoint path on the provided router
   *
   * @private
   * @param {string} file
   * @param {express.Router} router
   * @memberof FunctionParser
   */
  private buildEndpoint(
    file: string,
    groupName: string,
    router: express.Router
  ) {
    const filePath: ParsedPath = parse(file);

    const endpoint: Endpoint = require(file).default as Endpoint;

    const name: string =
      endpoint.name || filePath.name.replace('.endpoint', '');

    const { handler } = endpoint;

    // Enable cors if it is enabled globally else only enable it for a particular route
    if (this.enableCors) {
      router.use(cors());
    } else if (endpoint.options?.enableCors) {
      if (this.verbose) log(`Cors enabled for ${name}`);
      router.use(cors());
    }

    if (endpoint.options?.enableFileUpload) {
      if (this.verbose) log(`File upload enabled for ${name}`);
      router.use(fileUpload());
    }

    switch (endpoint.requestType) {
      case RequestType.GET:
        router.get(`/${groupName}/${name}`, endpoint.options?.middlewares ?? [], handler);
        break;

      case RequestType.POST:
        router.post(`/${groupName}/${name}`, endpoint.options?.middlewares ?? [], handler);
        break;

      case RequestType.PUT:
        router.put(`/${groupName}/${name}`, endpoint.options?.middlewares ?? [], handler);
        break;

      case RequestType.DELETE:
        router.delete(`/${groupName}/${name}`, endpoint.options?.middlewares ?? [], handler);
        break;

      case RequestType.PATCH:
        router.patch(`/${groupName}/${name}`, endpoint.options?.middlewares ?? [], handler);
        break;

      default:
        throw new Error(
          `A unsupported RequestType was defined for a Endpoint.\n
          Please make sure that the Endpoint file exports a RequestType
          using the constants in src/system/constants/requests.ts.\n
          **This value is required to add the Endpoint to the API**`
        );
    }
    if (this.verbose)
      log(
        `Restful Endpoints - Added ${groupName}/${endpoint.requestType}:${name}`
      );
  }
}
