import {
    IChaincodeComponent,
    IChaincodeFactory,
    IChaincodeHost,
    ICodeLoader,
} from "@prague/process-definitions";
import * as loader from "@prague/process-loader";
import {
    IDocumentService,
    IPlatform,
    IPlatformFactory,
    IRuntime,
    ITokenProvider,
    IUser,
} from "@prague/runtime-definitions";
import * as driver from "@prague/socket-storage";
import chalk from "chalk";
import * as commander from "commander";
import { EventEmitter } from "events";
import * as jwt from "jsonwebtoken";
import * as ora from "ora";
import * as process from "process";
import * as readline from "readline";

class MyPlatform extends EventEmitter implements IPlatform {
    public async queryInterface<T>(id: string): Promise<T> {
        return null;
    }
}

class MyChaincodeComponent implements IChaincodeComponent {
    public getModule(type: string) {
        console.log("getModule");
        return null;
    }

    public async close(): Promise<void> {
        console.log("close");
        return;
    }

    public async run(runtime: IRuntime, platform: IPlatform): Promise<IPlatform> {
        console.log("WE RUNNIN!");
        return new MyPlatform();
    }
}

class MyChaincodeHost implements IChaincodeHost {
    public getModule(type: string) {
        console.log("getModule");
        return null;
    }

    public async close(): Promise<void> {
        console.log("close");
        return;
    }

    public async run(runtime: IRuntime, platform: IPlatform): Promise<IPlatform> {
        console.log("MyChaincodeHost WE RUNNIN!");
        return new MyPlatform();
    }
}

class MyChaincodeFactory implements IChaincodeFactory {
    public async instantiateComponent(): Promise<IChaincodeComponent> {
        return new MyChaincodeComponent();
    }

    public async instantiateHost(): Promise<IChaincodeHost> {
        return new MyChaincodeHost();
    }
}

class NodeCodeLoader implements ICodeLoader {
    public async load(pkg: string): Promise<IChaincodeFactory> {
        console.log(`Loading ${pkg}`);
        return new MyChaincodeFactory();
    }
}

class NodePlatform extends EventEmitter implements IPlatform {
    public async queryInterface<T>(id: string): Promise<any> {
        return null;
    }
}

class NodePlatformFactory implements IPlatformFactory {
    public async create(): Promise<IPlatform> {
        return new NodePlatform();
    }
}

// tslint:disable-next-line:no-var-requires
const packageDetails = require("../package.json");

async function readlineAsync(input: readline.ReadLine, prompt: string): Promise<string> {
    return new Promise<string>((resolve) => {
        // tslint:disable-next-line:no-unnecessary-callback-wrapper
        input.question(prompt, (answer) => resolve(answer));
    });
}

async function run(
    id: string,
    tenantId: string,
    user: IUser,
    tokenProvider: ITokenProvider,
    options: any,
    reject: boolean,
    documentServices: IDocumentService,
): Promise<void> {
    const platformFactory = new NodePlatformFactory();
    const documentP = loader.load(
        id,
        tenantId,
        user,
        tokenProvider,
        null,
        platformFactory,
        documentServices,
        new NodeCodeLoader());
    ora.promise(documentP, `Loading ${tenantId}/${id}`);
    const document = await documentP;

    const quorum = document.getQuorum();
    console.log(chalk.yellow("Initial clients"), chalk.bgBlue(JSON.stringify(Array.from(quorum.getMembers()))));
    quorum.on("addMember", (clientId, details) => console.log(chalk.bgBlue(`${clientId} joined`)));
    quorum.on("removeMember", (clientId) => console.log(chalk.bgBlue(`${clientId} left`)));
    quorum.on(
        "addProposal",
        (proposal) => {
            if (reject) {
                console.log(chalk.redBright(`Reject ${proposal.key}=${proposal.value}@${proposal.sequenceNumber}`));
                proposal.reject();
            } else {
                console.log(chalk.yellowBright(`Propose ${proposal.key}=${proposal.value}@${proposal.sequenceNumber}`));
            }
        });
    quorum.on(
        "approveProposal",
        (sequenceNumber, key, value, approvalSequenceNumber) => {
            console.log(chalk.green(`Approve ${key}=${value}@${sequenceNumber}:${approvalSequenceNumber}`));
        });
    quorum.on(
        "commitProposal",
        (sequenceNumber, key, value, approvalSequenceNumber, commitSequenceNumber) => {
            console.log(chalk.green(
                `Commit ${key}=${value}@${sequenceNumber}:${approvalSequenceNumber}:${commitSequenceNumber}`));
        });
    quorum.on(
        "rejectProposal",
        (sequenceNumber, key, value, rejections) => {
            console.log(chalk.red(`Reject ${key}=${value}@${sequenceNumber} by ${rejections}`));
        });

    console.log("");
    console.log("Begin entering proposals (ctrl+c to quit)");
    console.log("");

    const input = readline.createInterface(process.stdin, process.stdout);
    // tslint:disable-next-line:no-constant-condition
    while (true) {
        const key = await readlineAsync(input, chalk.green("Key: "));
        const value = await readlineAsync(input, chalk.green("Value: "));

        // Accept both raw strings and JSON input
        let parsedValue: any;
        try {
            parsedValue = JSON.parse(value);
        } catch {
            parsedValue = value;
        }

        const proposeP = quorum.propose(key, parsedValue);
        ora.promise(proposeP, `Proposing that ${key} = ${JSON.stringify(parsedValue)}`);
    }
}

// Process command line input
let action = false;
commander
    .version(packageDetails.version)
    .option("-d, --deltas [deltas]", "Deltas URL", "http://localhost:3000")
    .option("-h, --snapshots [snapshots]", "Snapshots URL", "http://localhost:3001")
    .option("-t, --tenant [tenant]", "Tenant", "prague")
    .option("-s, --secret [secret]", "Secret", "43cfc3fbf04a97c0921fd23ff10f9e4b")
    .option("-r, --reject", "Reject")
    .arguments("<documentId>")
    .action((documentId) => {
        action = true;
        const documentServices = driver.createDocumentService(commander.deltas, commander.snapshots);
        const user = { id: "loader-client" };
        const token = jwt.sign(
            {
                documentId,
                permission: "read:write",
                tenantId: commander.tenant,
                user,
            },
            commander.secret);

        run(
            documentId,
            commander.tenant,
            user,
            new driver.TokenProvider(token),
            null,
            commander.reject,
            documentServices)
            .catch((error) => {
                console.error(error);
                process.exit(1);
            });
    })
    .parse(process.argv);

if (!action) {
    commander.help();
}
