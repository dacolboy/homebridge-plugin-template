/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { YamahaAPI } from './YamahaAPI.js';
import type { HomebridgePlatform } from './platform.js';
import { Cache } from './cache.js';
import { DeviceInfoResponse, StatusResponse, PlayInfoResponse, PresetInfoResponse } from './YamahaAPI.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class YamahaAccessory {
  private accessories: PlatformAccessory[] = [];

  private yamahaAPI: YamahaAPI;
  private config: any;
  private cache: Cache;
  private status!: StatusResponse;

  private tvService!: Service;
  private volService!: Service;

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    this.config = accessory.context.device;
    this.yamahaAPI = new YamahaAPI(this.platform.log, '');
    this.cache = new Cache(this.platform.log, platform.api.user.persistPath(), accessory.context.device.ip);
    this.accessories.push(accessory);
  }

  public async publishAccessory(PLUGIN_NAME: string) {
    await this.setInitialStatus();
    this.accessory.category = this.platform.api.hap.Categories.AUDIO_RECEIVER;
    this.addServiceAccessoryInformation(this.accessory);
    this.tvService = this.getTvService();
    this.platform.log.info('Adding new accessory:', this.config.displayName, 'Volumen');
    const volAccessory = new this.platform.api.platformAccessory(this.config.displayName,
      this.platform.api.hap.uuid.generate(this.config.uuid + 'volumen'), this.platform.api.hap.Categories.LIGHTBULB);
    this.addServiceAccessoryInformation(volAccessory);
    this.volService = this.getVolService(volAccessory);
    this.accessories.push(volAccessory);
    this.platform.api.publishExternalAccessories(PLUGIN_NAME, this.accessories);
    this.cache.setCallback(this.getHost(), this.updateStatus.bind(this));
  }

  private addServiceAccessoryInformation(accessory: PlatformAccessory) {
    const deviceInfo: DeviceInfoResponse = this.cache.get(this.getHost(), 'deviceInfo');
    accessory.getService(this.platform.api.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'Yamaha')
      .setCharacteristic(this.platform.api.hap.Characteristic.Model, deviceInfo.model_name)
      .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, deviceInfo.serial_number || this.config.ip)
      .setCharacteristic(this.platform.api.hap.Characteristic.SoftwareRevision, deviceInfo.api_version.toString())
      .setCharacteristic(this.platform.api.hap.Characteristic.FirmwareRevision, deviceInfo.system_version.toString());
  }

  private async setInitialStatus() {
    await this.cache.initStorage(this.config.ip);
    const presetInfo = await this.yamahaAPI.getPresetInfo(this.getHost());
    const conf = this.cache.get(this.getHost(), 'presetInfo') || { preset_info: [] };
    for (let i = 0; i < conf.preset_info.length; i++) {
      const currentPreset = presetInfo.preset_info.filter(p => p.text === conf.preset_info[i].text);
      if (currentPreset.length) {
        currentPreset.forEach(p => {
          delete conf.preset_info[i].presetId;
          delete conf.preset_info[i].identifier;
          Object.assign(p, conf.preset_info[i]);
        });
      }
    }
    this.cache.set(this.getHost(), 'presetInfo', presetInfo);

    this.cache.set(this.getHost(), 'deviceInfo', await this.yamahaAPI.getDeviceInfo(this.getHost()));
    //this.cache.set(this.getHost(), 'presetInfo', await this.yamahaAPI.getPresetInfo(this.getHost()));
    this.status = await this.yamahaAPI.getStatus(this.getHost());
    this.cache.set(this.getHost(), 'status', this.status);
    this.cache.set(this.getHost(), 'playInfo', await this.yamahaAPI.getPlayInfo(this.getHost()));
    this.cache.set(this.getHost(), 'features', await this.yamahaAPI.getFeatures(this.getHost()));
  }

  private getTvService() {
    const TVservice = this.accessory.addService(this.platform.Service.Television);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    TVservice.setCharacteristic(this.platform.Characteristic.ConfiguredName, this.accessory.context.device.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    TVservice.setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode, this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    TVservice.getCharacteristic(this.platform.Characteristic.Active)
      .onSet((value) => {
        this.setPower(value as boolean);
        this.cache.ping(this.getHost(), Boolean(value), true);
      })
      .onGet(() => {
        const isOn = this.getCurrentPowerSwitchStatus() ?
          this.platform.api.hap.Characteristic.Active.ACTIVE : this.platform.api.hap.Characteristic.Active.INACTIVE;
        this.platform.log.debug('Get Characteristic On ->', isOn);
        return isOn;
      });

    TVservice.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onSet(async (presetId: CharacteristicValue) => {
        const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
        await this.setPower(true);
        await this.recallInputPreset(presetId as number);
        this.cache.ping(this.getHost(), undefined, true);
        if (presetId as number > 100) {
          setTimeout(() => {
            const enhancerOn = Boolean(this.status.enhancer);
            const psName = presetInfos.preset_info.filter(p => p.identifier === presetId);
            const enhancerShouldBe = psName[0].displayText.indexOf('BBC') !== 0;
            this.platform.log.info('Enhancer: ', enhancerOn, '->', enhancerShouldBe);
            if (enhancerOn !== enhancerShouldBe) {
              this.yamahaAPI.setEnhancer(this.getHost(), enhancerShouldBe);
            }
          }, 1000);
        }
      })
      .onGet(() => {
        const curr = this.getCurrentInputPresetIdentifier();
        this.platform.log.debug('Get Active Identifier ->', curr);
        return curr || null;
      });

    const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
    for (const presetInfo of presetInfos.preset_info) {
      const inputSource = this.accessory.addService(this.platform.api.hap.Service.InputSource, presetInfo.displayText, presetInfo.identifier.toString());
      inputSource
        .setCharacteristic(this.platform.api.hap.Characteristic.Identifier, presetInfo.identifier)
        .setCharacteristic(this.platform.api.hap.Characteristic.IsConfigured, this.platform.api.hap.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.platform.api.hap.Characteristic.InputSourceType, this.platform.api.hap.Characteristic.InputSourceType.OTHER)
        .setCharacteristic(this.platform.api.hap.Characteristic.CurrentVisibilityState, presetInfo.hidden);

      inputSource.getCharacteristic(this.platform.api.hap.Characteristic.TargetVisibilityState)
        .onSet(async (hidden: CharacteristicValue) => {
          //inputSource.setCharacteristic(this.platform.api.hap.Characteristic.CurrentVisibilityState, hidden);
          presetInfo.hidden = hidden as number;
          this.cache.set(this.getHost(), 'presetInfo', presetInfos);
          inputSource.setCharacteristic(this.platform.api.hap.Characteristic.CurrentVisibilityState, hidden);
        }).updateValue(presetInfo.hidden);

      inputSource.getCharacteristic(this.platform.api.hap.Characteristic.ConfiguredName)
        .onSet((value) => {
          presetInfo.displayText = value as string;
          this.cache.set(this.getHost(), 'presetInfo', presetInfos);
        }).updateValue(presetInfo.displayText);

      TVservice.addLinkedService(inputSource);
    }

    // añado - otro - para cuando no está seleccionado la radio
    const inputSource = this.accessory.addService(this.platform.api.hap.Service.InputSource, '- otro -', 'otrootro');
    inputSource
      .setCharacteristic(this.platform.api.hap.Characteristic.Identifier, 100)
      .setCharacteristic(this.platform.api.hap.Characteristic.ConfiguredName, '- otro -')
      .setCharacteristic(this.platform.api.hap.Characteristic.IsConfigured, this.platform.api.hap.Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(this.platform.api.hap.Characteristic.InputSourceType, this.platform.api.hap.Characteristic.InputSourceType.OTHER)
      .setCharacteristic(this.platform.api.hap.Characteristic.CurrentVisibilityState, this.platform.api.hap.Characteristic.CurrentVisibilityState.SHOWN)
      .setCharacteristic(this.platform.api.hap.Characteristic.TargetVisibilityState, this.platform.api.hap.Characteristic.TargetVisibilityState.SHOWN);
    TVservice.addLinkedService(inputSource);


    const displayOrder = presetInfos.preset_info.map(presetInfo => presetInfo.identifier).concat([100]);
    TVservice.setCharacteristic(this.platform.api.hap.Characteristic.DisplayOrder, this.platform.api.hap.encode(1, displayOrder).toString('base64'));

    const speakerService = this.accessory.addService(this.platform.api.hap.Service.TelevisionSpeaker)
      .setCharacteristic(this.platform.api.hap.Characteristic.Active, this.platform.api.hap.Characteristic.Active.ACTIVE)
      .setCharacteristic(this.platform.api.hap.Characteristic.VolumeControlType, this.platform.api.hap.Characteristic.VolumeControlType.RELATIVE_WITH_CURRENT);

    speakerService.getCharacteristic(this.platform.api.hap.Characteristic.Volume)
      .onSet(this.setVolume.bind(this))
      .onGet(() => this.formatVolumeToHK(this.status.volume))
      .updateValue(this.formatVolumeToHK(this.status.volume));

    speakerService.getCharacteristic(this.platform.api.hap.Characteristic.Mute)
      .onSet((mute) => {
        this.yamahaAPI.setMute(this.getHost(), mute as boolean);
        this.status.mute = mute as boolean;
      })
      .onGet(() => {
        return this.status.mute;
      })
      .updateValue(this.status.mute);

    speakerService.getCharacteristic(this.platform.api.hap.Characteristic.VolumeSelector)
      .onSet((decrement) => {
        this.platform.log.info('Set volume selector ->', decrement);
        if (decrement) {
          this.yamahaAPI.setVolume(this.getHost(), this.status.volume - 5);
          this.status.volume -= 5;
        } else {
          this.yamahaAPI.setVolume(this.getHost(), this.status.volume + 5);
          this.status.volume += 5;
        }
      });

    return TVservice;
  }

  private getVolService(accessory: PlatformAccessory): Service {
    const bulbService = accessory.addService(this.platform.Service.Lightbulb);
    bulbService.getCharacteristic(this.platform.Characteristic.On)
      .onSet((on) => {
        this.yamahaAPI.setMute(this.getHost(), !on as boolean);
        this.status.mute = !on as boolean;
        this.platform.log.info('Set mute -> ', !on);
      })
      .onGet(() => !this.status.mute)
      .updateValue(!this.status.mute);

    bulbService.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setVolume.bind(this))
      .onGet(() => this.formatVolumeToHK(this.status.volume))
      .updateValue(this.formatVolumeToHK(this.status.volume));
    return bulbService;
  }

  private async updateStatus() {
    let status: StatusResponse;
    if (this.getCurrentPowerSwitchStatus()) {
      let playInfo: PlayInfoResponse;
      [status, playInfo] = await Promise.all([
        this.yamahaAPI.getStatus(this.getHost()),
        this.yamahaAPI.getPlayInfo(this.getHost()),
      ]);
      this.cache.set(this.getHost(), 'playInfo', playInfo);
    } else {
      status = await this.yamahaAPI.getStatus(this.getHost());
    }
    this.status = status;
    const lastStatus: StatusResponse = this.cache.get(this.getHost(), 'status');
    const poweredOn = status.power === 'on';
    const userActivity = JSON.stringify(lastStatus) !== JSON.stringify(status);
    this.cache.set(this.getHost(), 'status', status);
    this.cache.ping(this.getHost(), poweredOn, userActivity);

    const active = this.getCurrentPowerSwitchStatus() ? this.platform.api.hap.Characteristic.Active.ACTIVE :
      this.platform.api.hap.Characteristic.Active.INACTIVE;
    this.tvService.getCharacteristic(this.platform.api.hap.Characteristic.Active).updateValue(active);
    const presetId = this.getCurrentInputPresetIdentifier();
    if (presetId !== undefined) {
      this.tvService.getCharacteristic(this.platform.api.hap.Characteristic.ActiveIdentifier).updateValue(presetId);
    }
    this.volService.getCharacteristic(this.platform.Characteristic.Brightness).updateValue(this.formatVolumeToHK(status.volume));
  }

  private getCurrentInputPresetIdentifier(): number | undefined {
    const statusInfo: StatusResponse = this.cache.get(this.getHost(), 'status');
    const playInfo: PlayInfoResponse = this.cache.get(this.getHost(), 'playInfo');
    const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
    for (const presetInfo of presetInfos.preset_info) {
      if ((statusInfo.input === 'server' || statusInfo.input === 'net_radio') && (presetInfo.text === playInfo.track || presetInfo.text === playInfo.artist)) {
        return presetInfo.identifier;
      }
    }
    return 100;
  }

  private getCurrentPowerSwitchStatus(): boolean {
    const status: StatusResponse = this.cache.get(this.getHost(), 'status');
    return status.power === 'on';
  }

  private async setVolume(volume: CharacteristicValue) {
    const mappedVolume = this.formatVolumeToYamaha(volume as number);
    if (this.status.volume !== mappedVolume) {
      this.yamahaAPI.setVolume(this.getHost(), mappedVolume);
      this.status.volume = mappedVolume as number;
      this.platform.log.info('Set volume', volume, '->', mappedVolume);
    }
  }

  private async recallInputPreset(identifier: number) {
    this.platform.log.info('recall input preset a ', identifier);
    let input: string | undefined;
    let presetId: number | undefined;
    const presetInfos: PresetInfoResponse = this.cache.get(this.getHost(), 'presetInfo');
    for (const presetInfo of presetInfos.preset_info) {
      if (presetInfo.identifier === identifier) {
        presetId = Number(presetInfo.presetId);
        break;
      }
    }
    if (input) {
      //this.yamahaAPI.setInput(this.getHost(), input);
    } else if (presetId) {
      this.yamahaAPI.recallPreset(this.getHost(), presetId);
      return this.waitForInputPreset(identifier);
    }
    //return this.waitForInputPreset(identifier);
  }

  private async waitForInputPreset(identifier: number, maxWait: number = 10000) {
    const delay = 1000;
    const currentPresetIdentifier = this.getCurrentInputPresetIdentifier();
    if (currentPresetIdentifier !== identifier && maxWait > 0) {
      return setTimeout(async () => {
        await this.waitForInputPreset(identifier, maxWait - delay);
      }, delay);
    }
  }

  private async setPower(status: boolean) {
    this.platform.log.info('set poweramen a ', status);
    this.yamahaAPI.setPower(this.getHost(), status);
    return this.waitForPower(status);
  }

  private async waitForPower(status: boolean, maxWait: number = 10000) {
    const delay = 1000;
    const currentStatus = this.getCurrentPowerSwitchStatus();
    if (currentStatus !== status && maxWait > 0) {
      return setTimeout(async () => {
        await this.waitForPower(status, maxWait - delay);
      }, delay);
    }
  }

  public getHost(): string {
    return this.config.ip as string;
  }

  private formatVolumeToHK(volume: number): number {
    const maxvol = this.status.max_volume * this.config.volumePercentageHigh / 100;
    const minvol = this.status.max_volume * this.config.volumePercentageLow / 100;
    if (volume <= minvol) {
      return 0;
    }
    if (volume >= maxvol) {
      return 100;
    }
    return Math.round(100 * (volume - minvol) / (maxvol - minvol));
  }


  private formatVolumeToYamaha(volume: number): number {
    const maxvol = this.status.max_volume * this.config.volumePercentageHigh / 100;
    const minvol = this.status.max_volume * this.config.volumePercentageLow / 100;
    return Math.round(volume / 100 * (maxvol - minvol) + minvol);
  }

}
