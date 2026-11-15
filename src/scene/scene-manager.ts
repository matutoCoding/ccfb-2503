import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ProjectData, QualityLevel, Zone, ZoneType } from '../core/types';
import { windUniforms } from '../tree/materials';

const ZONE_COLORS: Record<ZoneType, number> = {
  lawn: 0x6f9e52,
  road: 0x707078,
  water: 0x4a86b8,
  paving: 0xb0a898,
};

/** 太阳轨迹（简化天文模型）：纬度固定 30°N，按日期和时刻算方位 */
export function sunPosition(seasonT: number, hour: number, target: THREE.Vector3): THREE.Vector3 {
  const dayAngle = seasonT * Math.PI * 2;
  const declination = 0.409 * Math.sin(dayAngle - 1.37); // 赤纬 ±23.44°
  const hourAngle = ((hour - 12) / 12) * Math.PI;
  const lat = THREE.MathUtils.degToRad(30);
  const elev = Math.asin(
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle),
  );
  const az = Math.atan2(
    -Math.cos(declination) * Math.sin(hourAngle),
    Math.cos(lat) * Math.sin(declination) - Math.sin(lat) * Math.cos(declination) * Math.cos(hourAngle),
  );
  const R = 120;
  const ce = Math.max(0.05, Math.cos(elev));
  target.set(
    R * ce * Math.sin(az),
    R * Math.sin(Math.max(elev, 0.06)),
    R * ce * Math.cos(az),
  );
  return target;
}

export interface SceneFps {
  fps: number;
  drawCalls: number;
  triangles: number;
}

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private sunTarget = new THREE.Object3D();
  private ground!: THREE.Mesh;
  private zoneLayer = new THREE.Group();
  private waterMeshes: THREE.Mesh[] = [];
  private raf = 0;
  private clock = new THREE.Clock();
  private frameCount = 0;
  private fpsTime = 0;
  private fps = 0;
  private onFrameCb: (() => void) | null = null;
  private disposed = false;

  constructor(
    private container: HTMLElement,
    private getProject: () => ProjectData,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 600);
    this.camera.position.set(70, 60, 90);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 320;

    // 天空 + 雾
    this.scene.background = new THREE.Color(0xbfd9ee);
    this.scene.fog = new THREE.Fog(0xbfd9ee, 130, 380);

    // 程序化环境贴图（IBL）：让 Standard 材质有环境反射，避免背光面死黑
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0xbfd9ee);
    const envRT = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = envRT.texture;
    pmrem.dispose();

    this.hemi = new THREE.HemisphereLight(0xdceeff, 0x9a8c6a, 1.15);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = 70;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 320;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    this.scene.add(this.zoneLayer);
    this.buildGround();
    this.resize();
    window.addEventListener('resize', this.resize);
    // 容器在 flex 布局中可能尚未完成排版（初始 clientWidth=0），用 RO 跟踪真实尺寸
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.loop();
  }

  private resizeObserver?: ResizeObserver;

  onFrame(cb: () => void): void {
    this.onFrameCb = cb;
  }

  private buildGround(): void {
    const size = this.getProject().settings.siteSize;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8aa868, roughness: 1 });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.ground.name = 'ground';
    this.scene.add(this.ground);

    // 场地边框
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size, 0.1, size)),
      new THREE.LineBasicMaterial({ color: 0x3d4d33 }),
    );
    edges.position.y = 0.02;
    this.ground.add(edges);

    // 网格（每 10m）
    const grid = new THREE.GridHelper(size, size / 10, 0x55703f, 0x7a965f);
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = 0.01;
    this.ground.add(grid);
  }

  /** 重建地面尺寸（场地大小变化时） */
  rebuildGround(): void {
    this.scene.remove(this.ground);
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.buildGround();
    this.rebuildZones();
  }

  /* ---------------- 场地分区 ---------------- */

  private zoneShape(zone: Zone): THREE.Shape {
    const shape = new THREE.Shape();
    zone.points.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, -p.z);
      else shape.lineTo(p.x, -p.z);
    });
    shape.closePath();
    return shape;
  }

  rebuildZones(): void {
    this.zoneLayer.clear();
    this.waterMeshes = [];
    for (const zone of this.getProject().zones) {
      const geo = new THREE.ShapeGeometry(this.zoneShape(zone));
      geo.rotateX(-Math.PI / 2);
      const isWater = zone.type === 'water';
      const mat = new THREE.MeshStandardMaterial({
        color: ZONE_COLORS[zone.type],
        roughness: isWater ? 0.15 : 0.95,
        metalness: isWater ? 0.35 : 0,
        transparent: isWater,
        opacity: isWater ? 0.82 : 0.9,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = isWater ? 0.04 : 0.03;
      mesh.receiveShadow = !isWater;
      mesh.userData.zoneId = zone.id;
      this.zoneLayer.add(mesh);
      if (isWater) this.waterMeshes.push(mesh);

      // 描边
      const pts = zone.points.map((p) => new THREE.Vector3(p.x, 0.06, p.z));
      pts.push(pts[0].clone());
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x2e3a28, transparent: true, opacity: 0.7 }),
      );
      this.zoneLayer.add(line);
    }
  }

  /* ---------------- 太阳 / 画质 ---------------- */

  updateSun(): void {
    const { seasonT, hour, shadow } = this.getProject().settings;
    sunPosition(seasonT, hour, this.sun.position);
    // 阴影相机跟随视点中心，保证近景树总有阴影
    const center = this.controls.target;
    this.sunTarget.position.copy(center);
    this.sun.position.add(center);
    this.sun.castShadow = shadow;
    // 晨昏光色
    const dayK = Math.sin(Math.min(1, Math.max(0, (hour - 6) / 3)) * Math.PI * 0.5)
      * Math.sin(Math.min(1, Math.max(0, (19 - hour) / 3)) * Math.PI * 0.5);
    this.sun.intensity = 0.6 + dayK * 1.8;
    this.sun.color.setHSL(0.1 - dayK * 0.02, 0.55, 0.55 + dayK * 0.35);
    this.hemi.intensity = 0.55 + dayK * 0.4;
  }

  setQuality(q: QualityLevel): void {
    this.renderer.shadowMap.enabled = this.getProject().settings.shadow;
    this.renderer.shadowMap.needsUpdate = true;
    this.sun.shadow.mapSize.set(q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024, q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    const fog = this.scene.fog as THREE.Fog;
    fog.near = q === 'low' ? 80 : q === 'high' ? 200 : 130;
    fog.far = q === 'low' ? 220 : q === 'high' ? 520 : 380;
  }

  /** 屏幕坐标 → 地面 y=0 交点 */
  screenToGround(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    return ray.ray.intersectPlane(plane, out) !== null;
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  getFps(): SceneFps {
    return {
      fps: this.fps,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  private resize = (): void => {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    windUniforms.uTime.value = t;
    windUniforms.uWind.value = this.getProject().settings.wind;

    // 水面微波动
    for (const w of this.waterMeshes) {
      w.position.y = 0.04 + Math.sin(t * 1.2 + w.userData.zoneId) * 0.012;
    }

    this.controls.update();
    this.onFrameCb?.();
    this.renderer.render(this.scene, this.camera);

    this.frameCount++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.frameCount / this.fpsTime);
      this.frameCount = 0;
      this.fpsTime = 0;
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
