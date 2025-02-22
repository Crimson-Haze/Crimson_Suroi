import { GameConstants, TeamSize } from "@common/constants";
import { Badges } from "@common/definitions/badges";
import { Mode } from "@common/definitions/modes";
import { Skins } from "@common/definitions/skins";
import { CustomTeamMessage, type GetGameResponse } from "@common/typings";
import { ColorStyles, Logger, styleText } from "@common/utils/logging";
import { Numeric } from "@common/utils/math";
import { Cron } from "croner";
import { existsSync, readFile, readFileSync, writeFile, writeFileSync } from "fs";
import { URLSearchParams } from "node:url";
import os from "os";
import { type WebSocket } from "uWebSockets.js";
import { isMainThread } from "worker_threads";
import { version } from "../../package.json";
import { Config } from "./config";
import { findGame, games, newGame, WorkerMessages } from "./gameManager";
import { CustomTeam, CustomTeamPlayer, type CustomTeamPlayerContainer } from "./team";
import IPChecker, { Punishment } from "./utils/apiHelper";
import { cleanUsername, modeFromMap } from "./utils/misc";
import { cors, createServer, forbidden, getIP, textDecoder } from "./utils/serverHelpers";

let punishments: Punishment[] = [];

const ipCheck = Config.protection?.ipChecker
    ? new IPChecker(Config.protection.ipChecker.baseUrl, Config.protection.ipChecker.key)
    : undefined;

const isVPN = Config.protection?.ipChecker
    ? new Map<string, boolean>()
    : new Map<string, boolean>(
        existsSync("isVPN.json")
            ? Object.entries(JSON.parse(readFileSync("isVPN.json", "utf8")) as Record<string, boolean>)
            : undefined
    );

async function isVPNCheck(ip: string): Promise<boolean> {
    if (!ipCheck) return false;

    let ipIsVPN = isVPN.get(ip);
    if (ipIsVPN !== undefined) return ipIsVPN;

    const result = await ipCheck.check(ip);
    if (!result?.flagged) return false;

    ipIsVPN = result.flagged;
    isVPN.set(ip, ipIsVPN);
    return ipIsVPN;
}

function removePunishment(ip: string): void {
    punishments = punishments.filter(p => p.ip !== ip);

    if (Config.protection?.punishments?.url) {
        fetch(
            `${Config.protection.punishments.url}/punishments/${ip}`,
            { method: "DELETE", headers: { "api-key": Config.protection.punishments.password } }
        ).catch(err => console.error("Error removing punishment from server. Details:", err));
    } else {
        writeFile(
            "punishments.json",
            JSON.stringify(punishments, null, 4),
            "utf8",
            err => {
                if (err) console.error(err);
            }
        );
    }
}

export function serverLog(...message: unknown[]): void {
    Logger.log(styleText("[Server]", ColorStyles.foreground.magenta.normal), ...message);
}

export function serverWarn(...message: unknown[]): void {
    Logger.warn(styleText("[Server] [WARNING]", ColorStyles.foreground.yellow.normal), ...message);
}

export function serverError(...message: unknown[]): void {
    Logger.warn(styleText("[Server] [ERROR]", ColorStyles.foreground.red.normal), ...message);
}

let teamsCreated: Record<string, number> = {};

export const customTeams: Map<string, CustomTeam> = new Map<string, CustomTeam>();

export let maxTeamSize = typeof Config.maxTeamSize === "number"
    ? Config.maxTeamSize
    : Config.maxTeamSize.rotation[0];

let nextTeamSize = typeof Config.maxTeamSize === "number"
    ? undefined
    : (Config.maxTeamSize.rotation[1] ?? Config.maxTeamSize.rotation[0]);

let teamSizeRotationIndex = 0;

let maxTeamSizeSwitchCron: Cron | undefined;

export let map = typeof Config.map === "string" ? Config.map : Config.map.rotation[0];

let mapRotationIndex = 0;

let mapSwitchCron: Cron | undefined;

let mode: Mode;
let nextMode: Mode;

if (isMainThread && require.main === module) {
    //              ^^^^^^^^^^^^^^^^^^^^^^^ only starts server if called directly from command line (not imported)

    process.on("uncaughtException", e => serverError("An unhandled error occurred. Details:", e));

    createServer().get("/api/serverInfo", async res => {
        cors(res);
        res
            .writeHeader("Content-Type", "application/json")
            .end(JSON.stringify({
                protocolVersion: GameConstants.protocolVersion,
                playerCount: games.reduce((a, b) => (a + (b?.aliveCount ?? 0)), 0),
                maxTeamSize,
                maxTeamSizeSwitchTime: maxTeamSizeSwitchCron?.nextRun()?.getTime(),
                nextTeamSize,
                mode,
                modeSwitchTime: mapSwitchCron?.nextRun()?.getTime(),
                nextMode
            }));
    }).get("/api/getGame", async(res, req) => {
        let aborted = false;
        res.onAborted(() => { aborted = true; });
        cors(res);

        const ip = getIP(res, req);

        let response: GetGameResponse;

        const punishment = punishments.find(p => p.ip === ip);
        if (punishment) {
            if (punishment.punishmentType === "warn") {
                const protection = Config.protection;
                if (protection?.punishments?.url) {
                    fetch(
                        `${protection.punishments.url}/punishments/${ip}`,
                        { headers: { "api-key": protection.punishments.password } }
                    ).catch(e => console.error("Error acknowledging warning. Details:", e));
                }
                removePunishment(ip);
            }
            response = { success: false, message: punishment.punishmentType, reason: punishment.reason, reportID: punishment.reportId };
        } else {
            const teamID = maxTeamSize !== TeamSize.Solo && new URLSearchParams(req.getQuery()).get("teamID"); // must be here or it causes uWS errors
            if (await isVPNCheck(ip)) {
                response = { success: false, message: "vpn" };
            } else if (teamID) {
                const team = customTeams.get(teamID);
                if (team?.gameID !== undefined) {
                    const game = games[team.gameID];
                    response = game && !game.stopped
                        ? { success: true, gameID: team.gameID }
                        : { success: false };
                } else {
                    response = { success: false };
                }
            } else {
                response = await findGame();
            }
        }

        if (response.success) {
            await games[response.gameID]?.allowIP(ip);
        }

        if (!aborted) {
            res.cork(() => {
                res.writeHeader("Content-Type", "application/json").end(JSON.stringify(response));
            });
        }
    }).get("/api/punishments", (res, req) => {
        cors(res);

        if (req.getHeader("password") === Config.protection?.punishments?.password) {
            res.writeHeader("Content-Type", "application/json").end(JSON.stringify(punishments));
        } else {
            forbidden(res);
        }
    }).get("/api/removePunishment", (res, req) => {
        cors(res);

        if (req.getHeader("password") === Config.protection?.punishments?.password) {
            const ip = new URLSearchParams(req.getQuery()).get("ip");
            if (ip) removePunishment(ip);
            res.writeStatus("204 No Content").endWithoutBody(0);
        } else {
            forbidden(res);
        }
    }).ws("/team", {
        idleTimeout: 30,

        /**
         * Upgrade the connection to WebSocket.
         */
        upgrade(res, req, context) {
            res.onAborted((): void => { /* Handle errors in WS connection */ });

            const ip = getIP(res, req);
            const maxTeams = Config.protection?.maxTeams;
            if (
                maxTeamSize === TeamSize.Solo
                || (maxTeams && teamsCreated[ip] > maxTeams)
            ) {
                forbidden(res);
                return;
            }

            const searchParams = new URLSearchParams(req.getQuery());
            const teamID = searchParams.get("teamID");

            let team!: CustomTeam;
            const noTeamIdGiven = teamID !== null;
            if (
                noTeamIdGiven
                // @ts-expect-error cleanest overall way to do this (`undefined` gets filtered out anyways)
                && (team = customTeams.get(teamID)) === undefined
            ) {
                forbidden(res);
                return;
            }

            if (noTeamIdGiven) {
                if (team.locked || team.players.length >= (maxTeamSize as number)) {
                    forbidden(res); // TODO "Team is locked" and "Team is full" messages
                    return;
                }
            } else {
                team = new CustomTeam();
                customTeams.set(team.id, team);

                if (Config.protection?.maxTeams) {
                    teamsCreated[ip] = (teamsCreated[ip] ?? 0) + 1;
                }
            }

            const name = cleanUsername(searchParams.get("name"));
            let skin = searchParams.get("skin") ?? GameConstants.player.defaultSkin;
            let badge = searchParams.get("badge") ?? undefined;

            //
            // Role
            //
            const password = searchParams.get("password");
            const givenRole = searchParams.get("role");
            let role = "";
            let nameColor: number | undefined;

            if (
                password !== null
                && givenRole !== null
                && givenRole in Config.roles
                && Config.roles[givenRole].password === password
            ) {
                role = givenRole;

                if (Config.roles[givenRole].isDev) {
                    try {
                        const colorString = searchParams.get("nameColor");
                        if (colorString) nameColor = Numeric.clamp(parseInt(colorString), 0, 0xffffff);
                    } catch { /* lol your color sucks */ }
                }
            }

            // Validate skin
            const skinDefinition = Skins.fromStringSafe(skin);
            const rolesRequired = skinDefinition?.rolesRequired;
            if (!skinDefinition || (rolesRequired && !rolesRequired.includes(role))) {
                skin = GameConstants.player.defaultSkin;
            }

            // Validate badge
            const badgeDefinition = badge ? Badges.fromStringSafe(badge) : undefined;
            if (!badgeDefinition || (badgeDefinition.roles && !badgeDefinition.roles.includes(role))) {
                badge = undefined;
            }

            res.upgrade(
                {
                    player: new CustomTeamPlayer(
                        team,
                        name,
                        skin,
                        badge,
                        nameColor
                    )
                },
                req.getHeader("sec-websocket-key"),
                req.getHeader("sec-websocket-protocol"),
                req.getHeader("sec-websocket-extensions"),
                context
            );
        },

        /**
         * Handle opening of the socket.
         * @param socket The socket being opened.
         */
        open(socket: WebSocket<CustomTeamPlayerContainer>) {
            const player = socket.getUserData().player;
            player.socket = socket;
            player.team.addPlayer(player);
        },

        /**
         * Handle messages coming from the socket.
         * @param socket The socket in question.
         * @param message The message to handle.
         */
        message(socket: WebSocket<CustomTeamPlayerContainer>, message: ArrayBuffer) {
            const player = socket.getUserData().player;
            try {
                void player.team.onMessage(player, JSON.parse(textDecoder.decode(message)) as CustomTeamMessage);
            } catch (e) {
                serverError("Error parsing team socket message. Details:", e);
            }
        },

        /**
         * Handle closing of the socket.
         * @param socket The socket being closed.
         */
        close(socket: WebSocket<CustomTeamPlayerContainer>) {
            const player = socket.getUserData().player;
            player.team.removePlayer(player);
        }
    }).listen(Config.host, Config.port, (): void => {
        process.stdout.write("\x1Bc"); // clears screen
        serverLog(`Suroi Server v${version}`);
        serverLog(`Listening on ${Config.host}:${Config.port}`);
        serverLog("Press Ctrl+C to exit.");

        void newGame(0);

        setInterval(() => {
            const memoryUsage = process.memoryUsage().rss;

            let perfString = `RAM usage: ${Math.round(memoryUsage / 1024 / 1024 * 100) / 100} MB`;

            // windows L
            if (os.platform() !== "win32") {
                const load = os.loadavg().join("%, ");
                perfString += ` | CPU usage (1m, 5m, 15m): ${load}%`;
            }

            serverLog(perfString);
        }, 60000);

        const teamSize = Config.maxTeamSize;
        if (typeof teamSize === "object") {
            maxTeamSizeSwitchCron = Cron(teamSize.switchSchedule, () => {
                maxTeamSize = teamSize.rotation[++teamSizeRotationIndex % teamSize.rotation.length];
                nextTeamSize = teamSize.rotation[(teamSizeRotationIndex + 1) % teamSize.rotation.length];

                for (const game of games) {
                    game?.worker.postMessage({ type: WorkerMessages.UpdateMaxTeamSize, maxTeamSize });
                }

                const humanReadableTeamSizes = [undefined, "solos", "duos", "trios", "squads"];
                serverLog(`Switching to ${humanReadableTeamSizes[maxTeamSize] ?? `team size ${maxTeamSize}`}`);
            });
        }

        mode = modeFromMap(map);

        const _map = Config.map;
        if (typeof _map === "object") {
            mapSwitchCron = Cron(_map.switchSchedule, () => {
                map = _map.rotation[++mapRotationIndex % _map.rotation.length];
                mode = modeFromMap(map);
                nextMode = modeFromMap(_map.rotation[(mapRotationIndex + 1) % _map.rotation.length]);

                for (const game of games) {
                    game?.worker.postMessage({ type: WorkerMessages.UpdateMap, map });
                }

                serverLog(`Switching to "${map}" map`);
            });
            nextMode = modeFromMap(_map.rotation[1] ?? _map.rotation[0]);
        }

        const { protection } = Config;
        if (protection) {
            setInterval(() => {
                if (protection.punishments?.url) {
                    void (async() => {
                        try {
                            if (!protection.punishments?.url) return;
                            const response = await fetch(`${protection.punishments.url}/punishments`, { headers: { "api-key": protection.punishments.password } });

                            // we hope that this is safe
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                            if (response.ok) punishments = await response.json();
                            else console.error("Error: Unable to fetch punishment list.");
                        } catch (e) {
                            console.error("Error: Unable to fetch punishment list. Details:", e);
                        }
                    })();
                } else {
                    if (!existsSync("punishments.json")) writeFileSync("punishments.json", "[]");
                    readFile("punishments.json", "utf8", (error, data) => {
                        if (error) {
                            console.error("Error: Unable to load punishment list. Details:", error);
                            return;
                        }

                        try {
                            // we also hope that this is safe
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                            punishments = data.trim().length ? JSON.parse(data) : [];
                        } catch (e) {
                            console.error("Error: Unable to parse punishment list. Details:", e);
                        }
                    });
                }

                const now = Date.now();

                for (let i = 0; i < punishments.length; i++) {
                    const punishment = punishments[i];
                    if (punishment.expires && new Date(punishment.expires).getTime() < now) {
                        punishments.splice(i, 1);
                        i--;
                    }
                }

                teamsCreated = {};

                if (!Config.protection?.ipChecker) {
                    writeFileSync("isVPN.json", JSON.stringify(Object.fromEntries(isVPN)));
                }

                Logger.log("Reloaded punishment list");
            }, protection.refreshDuration);
        }
    });
}
