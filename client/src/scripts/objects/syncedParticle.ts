import { ObjectCategory } from "@common/constants";
import { resolveNumericSpecifier, type InternalAnimation, type NumericSpecifier, type SyncedParticleDefinition } from "@common/definitions/syncedParticles";
import { getEffectiveZIndex } from "@common/utils/layer";
import { EaseFunctions, Numeric } from "@common/utils/math";
import { type ObjectsNetData } from "@common/utils/objectsSerializations";
import { Vec, type Vector } from "@common/utils/vector";
import { type Game } from "../game";
import { DIFF_LAYER_HITBOX_OPACITY, HITBOX_COLORS } from "../utils/constants";
import { SuroiSprite, toPixiCoords } from "../utils/pixi";
import { GameObject } from "./gameObject";

export class SyncedParticle extends GameObject.derive(ObjectCategory.SyncedParticle) {
    readonly image = new SuroiSprite();

    private _spawnTime = 0;
    private _age = 0;
    private _lifetime = 0;

    private _positionAnim?: InternalAnimation<Vector>;
    private _scaleAnim?: InternalAnimation<number>;
    private _alphaAnim?: InternalAnimation<number>;

    private _alphaMult = 1;

    angularVelocity = 0;

    private _definition!: SyncedParticleDefinition;
    get definition(): SyncedParticleDefinition { return this._definition; }

    constructor(game: Game, id: number, data: ObjectsNetData[ObjectCategory.SyncedParticle]) {
        super(game, id);

        this.container.addChild(this.image);
        this.updateFromData(data, true);
    }

    override updateFromData(data: ObjectsNetData[ObjectCategory.SyncedParticle], isNew = false): void {
        const {
            definition,
            startPosition,
            endPosition,
            layer,
            age,
            lifetime,
            angularVelocity,
            scale,
            alpha,
            variant,
            creatorID
        } = data;

        this._definition = definition;

        const easing = EaseFunctions[definition.velocity.easing ?? "linear"];
        this._positionAnim = {
            start: toPixiCoords(startPosition),
            end: toPixiCoords(endPosition),
            easing
        };
        this.forcePosition(Vec.lerp(startPosition, endPosition, easing(this._age)));

        this.layer = layer;
        this._lifetime = lifetime ?? definition.lifetime as number;
        this._age = age;
        this._spawnTime = Date.now() - this._age * this._lifetime;
        this.angularVelocity = angularVelocity ?? definition.angularVelocity as number;

        if (typeof definition.scale === "object" && "start" in definition.scale) {
            const start = scale?.start ?? definition.scale.start as number;
            const end = scale?.end ?? definition.scale.end as number;
            const easing = EaseFunctions[definition.scale.easing ?? "linear"];

            this._scaleAnim = { start, end, easing };
            this.updateScale();
        } else {
            const scale = resolveNumericSpecifier(definition.scale as NumericSpecifier);
            this.container.scale.set(scale, scale);
        }

        if (
            creatorID === this.game.activePlayerID
            && typeof definition.alpha === "object"
            && "creatorMult" in definition.alpha
            && definition.alpha.creatorMult !== undefined
        ) this._alphaMult = definition.alpha.creatorMult;

        if (typeof definition.alpha === "object" && "start" in definition.alpha) {
            const start = alpha?.start ?? definition.alpha.start as number;
            const end = alpha?.end ?? definition.alpha.end as number;
            const easing = EaseFunctions[definition.alpha.easing ?? "linear"];

            this._alphaAnim = { start, end, easing };
            this.updateAlpha();
        } else {
            this.container.alpha = resolveNumericSpecifier(definition.alpha as NumericSpecifier);
        }

        this.image.setFrame(`${definition.frame}${variant !== undefined ? `_${variant}` : ""}`);
        if (definition.tint) this.image.tint = definition.tint;
        this.updateZIndex();
    }

    override updateZIndex(): void {
        this.container.zIndex = getEffectiveZIndex(this.definition.zIndex, this.layer, this.game.layer);
    }

    override updateDebugGraphics(): void {
        if (!DEBUG_CLIENT) return;
        if (!this.definition.hitbox) return;

        this.game.debugRenderer.addHitbox(
            this.definition.hitbox.transform(this.position, this.container.scale.x),
            HITBOX_COLORS.obstacleNoCollision,
            this.layer === this.game.activePlayer?.layer ? 1 : DIFF_LAYER_HITBOX_OPACITY
        );
    }

    updateScale(): void {
        if (!this._scaleAnim) return;

        const { start, end, easing } = this._scaleAnim;
        this.container.scale.set(Numeric.lerp(start, end, easing(this._age)));
    }

    updateAlpha(): void {
        if (!this._alphaAnim) return;

        const { start, end, easing } = this._alphaAnim;
        this.container.alpha = Numeric.lerp(start, end, easing(this._age)) * this._alphaMult;
    }

    override update(): void {
        this._age = (Date.now() - this._spawnTime) / this._lifetime;
        if (this._age > 1 || !this._positionAnim) return;

        const { start, end, easing } = this._positionAnim;
        this.forcePosition(Vec.lerp(start, end, easing(this._age)));

        this.updateScale();
        this.updateAlpha();
    }

    override updateInterpolation(): void { /* bleh */ }

    override destroy(): void {
        super.destroy();
        this.image.destroy();
    }
}
