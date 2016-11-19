// homebridge-http-extensive
//
// This plugin was originally based on the homebridge-http-advanced plugin.
// It was then significantly modified to allow for covering more potential http scenarios.

var Service, Characteristic;
var request = require("request");
var pollingtoevent = require('polling-to-event');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-http-extensive", "Http-extensive", HttpExtensiveAccessory);
};


function HttpExtensiveAccessory(log, config) {
    this.log = log;

    // Characteristic info
    this.stateInfo = {
        "Lightbulb": {
            "true": true,
            "false": false
        },
        "Switch": {
            "true": true,
            "false": false
        },
        "SmokeSensor": {
            "true": Characteristic.SmokeDetected.SMOKE_DETECTED,
            "false": Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
        },
        "MotionSensor": {
            "true": true,
            "false": false
        },
        "LockMechanism": {
            "true": Characteristic.LockCurrentState.SECURED,
            "false": Characteristic.LockCurrentState.UNSECURED
        },
        "GarageDoorOpener": {
            "true": Characteristic.CurrentDoorState.CLOSED,
            "false": Characteristic.CurrentDoorState.OPEN
        }
    };

    this.targetInfo = {
        "LockMechanism": {
            "true": Characteristic.LockTargetState.SECURED,
            "false": Characteristic.LockTargetState.UNSECURED
        },
        "GarageDoorOpener": {
            "true": Characteristic.TargetDoorState.CLOSED,
            "false": Characteristic.TargetDoorState.OPEN
        }
    };

    // General info
    this.name = config["name"];
    this.service = config["service"] || "Switch";
	this.manufacturer = config["manufacturer"] || "HTTP Manufacturer";
	this.model = config["model"] || "HTTP Model";
	this.serial_number = config["serial_number"] || "HTTP Serial Number";

    // Authentication info
    this.username = config["username"] || "";
    this.password = config["password"] || "";
    this.sendimmediately = config["sendimmediately"] || "";

    // Get state (switches, lights, doors, locks, motion)
    this.get_state_url = config["get_state_url"];
    this.get_state_on_regex = config["get_state_on_regex"] || "1";
    this.get_state_off_regex = config["get_state_off_regex"] || "0";
    this.get_state_handling = config["get_state_handling"] || "onrequest";

    // Set state (switches, lights, doors, locks)
    this.set_state_url = config["set_state_url"];
    this.set_state_method = config["set_state_method"] || "POST";
    this.set_state_on = config["set_state_on"] || "1";
    this.set_state_off = config["set_state_off"] || "0";
    this.set_state_body = config["set_state_body"] || "{0}";

    // Get target (doors, locks)
    this.get_target_url = config["get_target_url"] || "";
    this.get_target_on_regex = config["get_target_on_regex"] || this.get_state_on_regex;
    this.get_target_off_regex = config["get_target_off_regex"] || this.get_state_off_regex;
    this.get_target_handling = config["get_target_handling"] || "onrequest";

    // Set target (doors, locks)
    this.set_target_url = config["set_target_url"] || "";
    this.set_target_method = config["set_target_method"] || this.set_state_method;
    this.set_target_on = config["set_target_on"] || this.set_state_on;
    this.set_target_off = config["set_target_off"] || this.set_state_off;
    this.set_target_body = config["set_target_body"] || this.set_state_body;

    // Get levels (dimmable lights)
    this.get_level_url = config["get_level_url"] || "";
    this.get_level_regex = config["get_level_regex"] || "\\d+";
    this.get_level_handling = config["get_level_handling"] || "onrequest";

    // Set levels (dimmable lights)
    this.set_level_url = config["set_level_url"] || "";
    this.set_level_method = config["set_level_method"] || this.set_state_method;
    this.set_level_body = config["set_level_body"] || "{0}";

    // Initialize our state to false
    this.state = false;
    this.targetState = false;

    // Initialize our level to 0
    this.currentlevel = 0;
    // Save off this as that
    var that = this;

    // Sensors will only work with continuous monitoring
    if (this.service === "SmokeSensor" || this.service === "MotionSensor") {
        this.get_state_handling = "continuous";
    }

    // Status Polling
    if ((this.get_state_url && this.get_state_handling === "continuous")) {
        var stateUrl = this.get_state_url;
        var statusemitter = pollingtoevent(function(done) {
            that.httpRequest(stateUrl, "", "GET", that.username, that.password, that.sendimmediately, function(error, response, body) {
                if (error) {
                    that.log('HTTP get state failed: %s', error.message);
                } else {
                    done(null, body);
                }
            });
        }, {
            longpolling: true,
            interval: 2000,
            longpollEventName: "statuspoll"
        });

        statusemitter.on("statuspoll", function(data) {
            var reOn = new RegExp(that.get_state_on_regex);
            var reOff = new RegExp(that.get_state_off_regex);
            var foundOn = reOn.test(data);
            var foundOff = reOff.test(data);

            if (foundOn || foundOff) {
                // Is the previous state different than the new state?
                var previousState = that.state;

                // Found a state
                that.state = foundOn;

                if (that.state !== previousState) {
                    that.log("STATEPOLL: %s, %s changed to %s", that.name, that.service, that.state.toString());
                }

                // Set a flag to indicate the the values are getting set during the polling callback
                that.settingValueDuringPolling = true;
                var stateInfo = that.stateInfo[that.service];
                
                if (stateInfo) {
                    if (that.stateCharacteristic) {
                        var value = stateInfo[that.state.toString()];
                        that.stateCharacteristic.setValue(value);
                    }
                }
                delete that.settingValueDuringPolling;
            } else {
                that.log(that.service, "get_state_url did not return a valid state");
            }
        });
    }

    // target Polling
    if ((this.get_target_url && this.get_target_handling === "continuous")) {
        var targetUrl = this.get_target_url;
        var targetemitter = pollingtoevent(function(done) {
            that.httpRequest(targetUrl, "", "GET", that.username, that.password, that.sendimmediately, function(error, response, body) {
                if (error) {
                    that.log('HTTP get target failed: %s', error.message);
                } else {
                    done(null, body);
                }
            });
        }, {
            longpolling: true,
            interval: 2000,
            longpollEventName: "targetpoll"
        });

        targetemitter.on("targetpoll", function(data) {
            var reOn = new RegExp(that.get_target_on_regex);
            var reOff = new RegExp(that.get_target_off_regex);
            var foundOn = reOn.test(data);
            var foundOff = reOff.test(data);

            if (foundOn || foundOff) {
                // Is the previous state different than the new state?
                var target = foundOn;

                if (target !== that.targetState) {
                    that.log("TARGETPOLL: %s, %s changed to %s", that.name, that.service, target.toString());
                    that.targetState = target;
                }

                // Set a flag to indicate the the values are getting set during the polling callback
                that.settingTargetValueDuringPolling = true;
                var targetInfo = that.targetInfo[that.service];
                
                if (targetInfo) {
                    if (that.targetCharacteristic) {
                        var value = targetInfo[target.toString()];

                        that.targetCharacteristic.setValue(value);
                    }
                }
                delete that.settingTargetValueDuringPolling;
            } else {
                that.log(that.service, "get_target_url did not return a valid state");
            }
        });
    }


    // Level Polling
    if (this.get_level_url && this.get_level_handling === "continuous") {
        var levelurl = this.get_level_url;
        var levelemitter = pollingtoevent(function(done) {
            that.httpRequest(levelurl, "", "GET", that.username, that.password, that.sendimmediately, function(error, response, responseBody) {
                if (error) {
                    that.log('HTTP get level failed: %s', error.message);
                    return;
                } else {
                    done(null, responseBody);
                }
            });
        }, {
            longpolling: true,
            interval: 2000,
            longpollEventName: "levelpoll"
        });

        levelemitter.on("levelpoll", function(data) {
            var re = new RegExp(that.get_level_regex);
            var matches = data.match(re);

            if (matches) {
                that.currentlevel = parseInt(matches[1], 10);

                if (that.levelCharacteristic) {
                    that.log(that.service, "received data:" + that.get_level_url, "level is currently", that.currentlevel);
                    // Set a flag to indicate the the values are getting set during the polling callback
                    that.settingLevelValueDuringPolling = true;
                    that.levelCharacteristic
                        .setValue(that.currentlevel);
                    delete that.settingLevelValueDuringPolling;
                }
            } else {
                that.log(that.service, "get_level_url did not return a response that matched get_level_regex");
            }
        });
    }
}

HttpExtensiveAccessory.prototype = {
    format: function(format) {
        var args = Array.prototype.slice.call(arguments, 1);
        return format.replace(/{(\d+)}/g, function(match, number) {
            return typeof args[number] !== 'undefined' ?
                args[number] :
                match;
        });
    },

    httpRequest: function(url, body, method, username, password, sendimmediately, callback) {
        request({
                url: url,
                body: body,
                method: method,
                rejectUnauthorized: false,
                auth: {
                    user: username,
                    pass: password,
                    sendImmediately: sendimmediately
                }
            },
            // error, response, body
            callback);
    },

    getGenericState: function(type, url, regexOn, regexOff, callback) {
        if (!url) {
            this.log.warn("Ignoring request; No " + type + " url defined.");
            callback(new Error("No " + type + " url defined."));
            return;
        }

        this.log("GETSTATE: %s", type);

        this.httpRequest(url, "", "GET", this.username, this.password, this.sendimmediately, function(error, response, responseBody) {
            if (error) {
                this.log('HTTP get %s state failed: %s', type, error.message);
                callback(error);
            } else {
                var reOn = new RegExp(regexOn);
                var reOff = new RegExp(regexOff);
                var foundOn = reOn.test(responseBody);
                var foundOff = reOff.test(responseBody);

                if (foundOn || foundOff) {
                    var state = foundOn;
                    this.log("GETSTATE: %s returned: %s", type, state.toString());
                    callback(null, state);
                } else {
                    this.log('HTTP get %s did not return a valid state', type);
                    callback(new Error('No valid state returned for ' + type));
                }
            }
        }.bind(this));
    },

    getStatusState: function(callback) {
        this.getGenericState("status", this.get_state_url, this.get_state_on_regex, this.get_state_off_regex, callback);
    },

    setGenericState: function(type, url, method, body, onStr, offStr, value, callback) {
        // If this function is getting called during the polling callback, then the device is already set to the proper
        // value so we don't need to call http to set it on the device.
        if (this.settingValueDuringPolling || this.settingTargetValueDuringPolling) {
            callback();
            return;
        }
        if (!url) {
            this.log.warn("Ignoring request; No " + type + " url defined.");
            callback(new Error("No " + type + " url defined."));
            return;
        }

        var valueStr = value ? onStr : offStr;
        this.log('SETSTATE: %s to %s', type, valueStr);
        var completeUrl = this.format(url, valueStr);
        var completeBody = this.format(body, valueStr);

        this.httpRequest(completeUrl, completeBody, method, this.username, this.password, this.sendimmediately, function(error, response) {
            if (error) {
                this.log('HTTP set %s function failed: %s', type, error.message);
                callback(error);
            } else {
                if (response.statusCode === 200) {
                    this.log('HTTP set %s function succeeded!', type);
                    callback();
                } else {
                    this.log('set %s returned statusCode: %s', type, response.statusCode);
                    callback(new(Error("set " + type + " returned statusCode: " + response.statusCode)));
                }
            }
        }.bind(this));
    },

    setStatusState: function(powerOn, callback) {
        this.setGenericState("set_state_url", this.set_state_url, this.set_state_method, this.set_state_body, this.set_state_on, this.set_state_off, powerOn, callback);
    },

    getTargetState: function(callback) {
        this.getGenericState("get_target_url", this.get_target_url, this.get_target_on_regex, this.get_target_off_regex, callback);
    },

    setTargetState: function(value, callback) {
        this.setGenericState("set_target_url", this.set_target_url, this.set_target_method, this.set_target_body, this.set_target_on, this.set_target_off, value, callback);
    },

    getLevel: function(callback) {
        if (!this.get_level_url) {
            this.log.warn("Ignoring request; No get_level_url defined.");
            callback(new Error("No get_level_url defined."));
            return;
        }
        var url = this.get_level_url;
        this.log("Getting level");

        this.httpRequest(url, "", "GET", this.username, this.password, this.sendimmediately, function(error, response, responseBody) {
            if (error) {
                this.log('HTTP get level function failed: %s', error.message);
                callback(error);
            } else {
                var re = new RegExp(this.get_level_regex);
                var matches = responseBody.match(re);
                if (matches) {
                    // Get the first match
                    var level = parseInt(matches[1], 10);
                    this.log("The level is currently %s", level);
                    callback(null, level);
                } else {
                    this.log('get_level_url failed to return a response that matched the regular expression in get_level_regex');
                    callback(new Error('get_level_url failed to return a valid response'));
                }
            }
        }.bind(this));
    },

    setLevel: function(level, callback) {
        if (this.settingLevelValueDuringPolling) {
            callback();
            return;
        }
        if (!this.set_level_url) {
            this.log.warn("Ignoring request; No set_level_url defined.");
            callback(new Error("No set_level_url defined."));
            return;
        }

        var completeUrl = this.format(this.set_level_url, level);
        var completeBody = this.format(this.set_level_body, level);

        this.log("Setting level to %s", level);

        this.httpRequest(completeUrl, completeBody, this.set_level_method, this.username, this.password, this.sendimmediately, function(error, response) {
            if (error) {
                this.log('HTTP set_level_url function failed: %s', error);
                callback(error);
            } else {
                if (response.statusCode === 200) {
                    this.log('HTTP set_level_url function succeeded!');
                    callback();
                } else {
                    this.log("HTTP set_level_url failed with response code: %s", response.statusCode);
                    callback(new Error("set_level_url returned code: " + response.statusCode));
                }
            }
        }.bind(this));
    },

    identify: function(callback) {
        this.log("Identify requested!");
        callback(); // success
    },

    getServiceObj: function(serviceType) {
        var service;
        switch (serviceType) {
            case "Switch":
                service = new Service.Switch(this.name);
                break;
            case "Lightbulb":
                service = new Service.Lightbulb(this.name);
                break;
            case "LockMechanism":
                service = new Service.LockMechanism(this.name);
                break;
            case "SmokeSensor":
                service = new Service.SmokeSensor(this.name);
                break;
            case "MotionSensor":
                service = new Service.MotionSensor(this.name);
                break;
            case "GarageDoorOpener":
                service = new Service.GarageDoorOpener(this.name);
                break;
            default:
                this.log("Unsupported service: %s", serviceType);
                service = null;
                break;
        }
        return service;
    },

    getStateCharacteristic: function(serviceType) {
        var stateCharacteristic;
        switch (serviceType) {
            case "Switch":
            case "Lightbulb":
                stateCharacteristic = this.serviceObj.getCharacteristic(Characteristic.On);
                break;
            case "LockMechanism":
                stateCharacteristic = this.serviceObj.getCharacteristic(Characteristic.LockCurrentState);
                break;
            case "SmokeSensor":
                stateCharacteristic = this.serviceObj.getCharacteristic(Characteristic.SmokeDetected);
                break;
            case "MotionSensor":
                stateCharacteristic = this.serviceObj.getCharacteristic(Characteristic.MotionDetected);
                break;
            case "GarageDoorOpener":
                stateCharacteristic = this.serviceObj.getCharacteristic(Characteristic.CurrentDoorState);
                break;
            default:
                this.log("Unsupported service: %s", serviceType);
                stateCharacteristic = null;
                break;
        }
        return stateCharacteristic;
    },

    getTargetCharacteristic: function(serviceType) {
        var targetCharacteristic;
        switch (serviceType) {
            case "LockMechanism":
                targetCharacteristic = this.serviceObj.getCharacteristic(Characteristic.LockTargetState);
                break;
            case "GarageDoorOpener":
                targetCharacteristic = this.serviceObj.getCharacteristic(Characteristic.TargetDoorState);
                break;
            case "Switch":
            case "Lightbulb":
            case "SmokeSensor":
            case "MotionSensor":
                this.log("%s %s doesn't support a get_target_url", serviceType, this.name);
                targetCharacteristic = null;
                break;
            default:
                this.log("Unsupported service: %s", serviceType);
                targetCharacteristic = null;
                break;
        }
        return targetCharacteristic;
    },

    getLevelCharacteristic: function(serviceType) {
        var levelCharacteristic;
        switch (serviceType) {
            case "Lightbulb":
                levelCharacteristic = this.serviceObj.addCharacteristic(new Characteristic.Brightness());
                break;
            case "Switch":
            case "LockMechanism":
            case "SmokeSensor":
            case "MotionSensor":
            case "GarageDoorOpener":
                this.log("%s %s doesn't support a get_level_url", serviceType, this.name);
                levelCharacteristic = null;
                break;
            default:
                this.log("Unsupported service: %s", serviceType);
                levelCharacteristic = null;
                break;
        }
        return levelCharacteristic;
    },

    getServices: function() {
        var that = this;

        var informationService = new Service.AccessoryInformation();

        informationService
            .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, this.serial_number);

        switch (this.service) {
            case "Switch":
            case "SmokeSensor":
            case "MotionSensor":
            case "Lightbulb":
            case "LockMechanism":
            case "GarageDoorOpener":
                this.serviceObj = this.getServiceObj(this.service);
                this.stateCharacteristic = this.getStateCharacteristic(this.service);

                if (this.service === "SmokeSensor" || this.service === "MotionSensor") {
                    this.get_state_handling = "continuous";
                }

                // Handle state characteristics
                if (this.get_state_url || this.set_state_url) {
                    if (this.get_state_url) {
                        if (this.get_state_handling === "continuous") {
                            this.stateCharacteristic.on('get', function(callback) {
                                callback(null, that.state);
                            });
                        } else {
                            this.stateCharacteristic.on('get', this.getStatusState.bind(this));
                        }
                    }

                    if (this.set_state_url) {
                        this.stateCharacteristic.on('set', this.setStatusState.bind(this));
                    }
                } else {
                    this.log.warn("%s %s is missing get_state_url or set_state_url", this.service, this.name);
                }

                // Handle target characteristics
                if (this.get_target_url || this.set_target_url) {
                    this.targetCharacteristic = this.getTargetCharacteristic(this.service);

                    if (this.get_target_url) {
                        if (this.get_target_handling === "continuous") {
                            this.targetCharacteristic.on('get', function(callback) {
                                callback(null, that.targetState);
                            });
                        } else {
                            this.targetCharacteristic.on('get', this.getTargetState.bind(this));
                        }
                    }

                    if (this.set_target_url) {
                        this.targetCharacteristic.on('set', this.setTargetState.bind(this));
                    }
                } else {
                    this.log.warn("%s %s is missing get_target_url or set_target_url", this.service, this.name);
                }

                // Handle level characteristics
                if (this.get_level_url || this.set_level_url) {
                    this.levelCharacteristic = this.getLevelCharacteristic(this.service);

                    if (this.levelCharacteristic) {
                        if (this.get_level_url) {
                            if (this.get_level_handling === "continuous") {
                                this.levelCharacteristic.on('get', function(callback) {
                                    callback(null, that.currentlevel);
                                });
                            } else {
                                this.levelCharacteristic.on('get', this.getLevel.bind(this));
                            }
                        }

                        if (this.set_level_url) {
                            this.levelCharacteristic.on('set', this.setLevel.bind(this));
                        }
                    }
                }

                return [informationService, this.serviceObj];
        }
    }
};
