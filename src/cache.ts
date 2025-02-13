/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import {
  Logging,
} from 'homebridge';
import { DeviceInfoResponse, FeatureResponse, PlayInfoResponse, PresetInfoResponse, StatusResponse } from './YamahaAPI';
import storage from 'node-persist';
import path from 'path';

interface YamahaDeviceCache {
  presetInfo?: PresetInfoResponse;
  status?: StatusResponse;
  playInfo?: PlayInfoResponse;
  deviceInfo?: DeviceInfoResponse;
  features?: FeatureResponse;
}
export class Cache {
  private readonly log: Logging;
  private readonly hosts: Set<string> = new Set();
  private readonly cache: { [host: string]: YamahaDeviceCache } = {};
  private readonly callbacks: { [host: string]: { callback: Function } } = {};
  private readonly lastUserActivity: { [host: string]: Date } = {};
  private readonly lastPoweredOn: { [host: string]: Date } = {};
  private readonly lastStatusUpdate: { [host: string]: Date } = {};
  private persistPath: string;

  private readonly updateIntervalPoweredOff = 30 * 1000;
  private readonly updateIntervalPoweredOn = 10 * 1000;
  private readonly updateIntervalUserActivity = 1 * 1000;

  constructor(log: Logging, userPersistPath: string, ip: string) {
    this.log = log;
    this.update();
    this.persistPath = path.join(userPersistPath, '/../yamaha-persist', ip);
  }

  async initStorage(host: string) {
    await storage.init({ dir: this.persistPath,forgiveParseErrors: true })
      .then(() => storage.getItem('cachedPresetInfo'))
      .then((info) => this.set(host, 'presetInfo', info || { preset_info: [] } ));

  }
  
  private async update() {
    const promises: unknown[] = [];
    for (const host of this.hosts) {
      const now = new Date().getTime();
      if (
        (this.lastStatusUpdate[host].getTime() <= (now - this.updateIntervalPoweredOff))
        ||
        ((this.lastStatusUpdate[host].getTime() <= (now - this.updateIntervalPoweredOn)) 
          && (this.lastPoweredOn[host].getTime() >= (now - this.updateIntervalPoweredOff)))
        ||
        ((this.lastStatusUpdate[host].getTime() <= (now - this.updateIntervalUserActivity)) 
          && (this.lastUserActivity[host].getTime() >= (now - this.updateIntervalPoweredOn)))
      ) {
        promises.push(this.updateHost(host));
      }
    }
    setTimeout(async () => {
      this.update();
    }, 1000);
    return Promise.all(promises);
  }
  private async updateHost(host: string) {
    this.lastStatusUpdate[host] = new Date();
    if (host in this.callbacks) {
      return this.callbacks[host].callback();
    }
  }
  public setCallback(host: string, callback: Function) {
    this.hosts.add(host);
    this.lastUserActivity[host] = new Date();
    this.lastPoweredOn[host] = new Date();
    this.lastStatusUpdate[host] = new Date();
    return this.callbacks[host] = { callback: callback };
  }
  public ping(host: string, poweredOn?: boolean, userActivity?: boolean) {
    if (poweredOn) {
      this.lastPoweredOn[host] = new Date();
    }
    if (userActivity) {
      this.lastUserActivity[host] = new Date();
    }
  }
  public set(host: string, key: 'presetInfo' | 'status' | 'playInfo' | 'deviceInfo' | 'features', value: any): unknown {
    if (!(host in this.cache)) {
      this.cache[host] = {};
    }
    if (key === 'presetInfo') {
      storage.setItem('cachedPresetInfo', value);
    }
    return this.cache[host][key] = value;
  }
  public get(host: string, key: 'presetInfo' | 'status' | 'playInfo' | 'deviceInfo' | 'features'): any {
    if (host in this.cache && key in this.cache[host]) {
      return this.cache[host][key];
    }
    this.log.warn(`cache not found ${host} ${key}`);
  }
}
