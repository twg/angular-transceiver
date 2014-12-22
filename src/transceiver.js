/* global angular */
angular.module('transceiver', [])

  //  connectTransceiver should be called from a service, once, to set up the socket connection.
  .factory('connectTransceiver', ['$rootScope', '$http', '$timeout', '$location', '$log',
    function($rootScope, $http, $timeout, $location, $log) {
      "use strict";

      function asyncAngularify(socket, callback) {
        return callback ? function() {
          var args = arguments;
          $timeout(function() {
            callback.apply(socket, args);
          }, 0);
        } : angular.noop;
      }

      var Socket = function(options) {
        var optionDefaults = {
          url: $location.path(),
          defaultScope: $rootScope,
          eventPrefix: 'socket:',
          eventForwards: ['connect', 'disconnect'],
          modelEventForwards: ['create', 'destroy', 'update', 'enter', 'exit'],

          reconnectionAttempts: Infinity,
          reconnectionDelay: function(attempt) {
            var maxDelay = 10000;
            var bo = ((Math.pow(2, attempt) - 1) / 2);
            var delay = 1000 * bo; // 1 sec x backoff amount
            return Math.min(delay, maxDelay);
          }
        };

        this.canReconnect = true;
        this.disconnectRetryTimer = null;
        this.options = angular.extend({}, optionDefaults, options);
        this.undoManager = options.undoManager;
        this.ioSocket = null;
      };

      Socket.prototype.on = function addSocketListener(eventName, callback) {
        this.ioSocket.on(eventName, asyncAngularify(this, callback));
      };
      Socket.prototype.addListener = Socket.prototype.on;

      Socket.prototype.off = function removeSocketListener() {
        return this.ioSocket.removeListener.apply(this, arguments);
      };
      Socket.prototype.removeListener = Socket.prototype.off;

      Socket.prototype.request = function requestAction(url, data, cb, errorCb, method) {
        var me = this;
        var socketId = this.ioSocket.io.engine.id;
        if (!socketId) {
          //  Wait for our connection event, then re-fire this request.
          var originalArgs = arguments;
          this.on('connect', function() {
            me.request.apply(me, originalArgs);
          });
          return;
        }

        var usage = 'Usage:\n socket.' + (method || 'request') +
          '(destinationURL, dataToSend, fnToCallWhenComplete)';

        // Remove trailing slashes and spaces
        url = url.replace(/^(.+)\/*\s*$/, '$1');

        // If method is undefined, use 'get'
        method = method || 'get';

        if (typeof url !== 'string') {
          throw new Error('Invalid or missing URL!\n' + usage);
        }

        // Allow data arg to be optional
        if (typeof data === 'function') {
          cb = data;
          data = {};
        }

        // Build to request
        var json = angular.toJson({
          url: url,
          data: data
        });

        $http({
          method: method,
          url: url,
          data: angular.toJson(data),
          headers: {"X-Transceiver-Socket-ID": socketId},
        }).success(function(result) {
          if (cb) {
            cb({statusCode: 200, body: result});
          }
        }).error(function(data, status, headers) {
          $log.warn("Server returned error ", data, status);
          if (errorCb) {
            errorCb(data, status, headers);
          }

          if (status === 0) {
            //  Status code of 0 indicates that the
            //  internet has been disconnected.
            me.ioSocket.disconnect();
          }
        });
      };

      Socket.prototype.get = function(url, data, cb, error) {
        return this.request(url, data, cb, error || this.options.errorCallback, 'get');
      };
      Socket.prototype.post = function(url, data, cb, error) {
        return this.request(url, data, cb, error || this.options.errorCallback, 'post');
      };
      Socket.prototype.put = function(url, data, cb, error) {
        return this.request(url, data, cb, error || this.options.errorCallback, 'put');
      };
      Socket.prototype.delete = function(url, data, cb, error) {
        return this.request(url, data, cb, error || this.options.errorCallback, 'delete');
      };

      /*
       *  Undoable Socket Functions
       */
      Socket.prototype.undoableCreate = function(model, data, cb, error, isUndoOfDelete, isRedoOfCreate) {
        var url = "/api/v1/" + model;

        if (!isUndoOfDelete && !isRedoOfCreate && this.undoManager) {
          this.undoManager.clearRedoStack();
        }

        var _this = this;
        return _this.request(url, data, function(response) {
          var newData = response.body;

          if (_this.undoManager) {
            if (isUndoOfDelete) {
              //  We just undid a delete, so this create will
              //  override the ID parameter of previous undoable calls.
              //  We need to replace ID parameters in the undo stack.
              _this.undoManager.replaceIDs(model, data.id, newData.id);
            } else {
              var undoData = {
                model: model,
                data: newData,
                id: newData.id,
              };
              _this.undoManager.addUndo(function(undoData) {
                var newData = undoData.data;
                var model = undoData.model;

                _this.undoableDelete(model, newData, function() {
                  // Push the original creation function onto the redo stack.
                  var redo = function(redoData) {
                    var model = redoData.model;
                    var data = redoData.data;
                    _this.undoableCreate(model, data, function(recreatedObject) {
                      _this.undoManager.replaceIDs(model, data.id, recreatedObject.id);
                    }, undefined, false, true);
                  };

                  if (_this.undoManager) {
                    var redoData = {
                      model: model,
                      data: newData,
                      id: newData.id,
                    };
                    _this.undoManager.addRedo(redo, redoData);
                  }
                }, undefined, true, false);
              }, undoData);
            }
          }

          return cb && cb(newData);
        }, error || this.options.errorCallback, 'post');
      };

      Socket.prototype.undoableUpdate = function(model, id, data, update, cb, error, isUndo, isRedo) {
        data = angular.copy(data);
        update = angular.copy(update);

        var url = "/api/v1/" + model + "/" + id;

        if (!isUndo && !isRedo && this.undoManager) {
          this.undoManager.clearRedoStack();
        }

        var _this = this;
        return _this.request(url, update, function(response) {
          if (!isUndo && _this.undoManager) {
            var undoData = {
              model: model,
              id: id,
              data: data,
              update: update,
            };

            _this.undoManager.addUndo(function(undoData) {
              var model = undoData.model;
              var id = undoData.id;
              var data = undoData.data;
              var update = undoData.update;
              _this.undoableUpdate(model, id, update, data, function() {
                // Push a new revert function onto the redo stack.
                if (_this.undoManager) {
                  var redoData = {
                    model: model,
                    id: id,
                    data: data,
                    update: update,
                  };

                  _this.undoManager.addRedo(function(redoData) {
                    var model = redoData.model;
                    var id = redoData.id;
                    var data = redoData.data;
                    var update = redoData.update;
                    _this.undoableUpdate(model, id, data, update, undefined, undefined, false, true);
                  }, redoData);
                }
              }, undefined, true, false);
            }, undoData);
          }

          return cb && cb(response);
        }, error || this.options.errorCallback, 'post');
      };

      Socket.prototype.undoableDelete = function(model, data, cb, error, isUndoOfCreate, isRedoOfDelete) {
        var url = "/api/v1/" + model + "/" + data.id;

        if (!isUndoOfCreate && !isRedoOfDelete && this.undoManager) {
          this.undoManager.clearRedoStack();
        }

        var _this = this;
        return _this.request(url, null, function(response) {
          if (_this.undoManager) {
            if (!isUndoOfCreate) {
              var undoData = {
                model: model,
                data: data,
                id: data.id,
              };
              _this.undoManager.addUndo(function(undoData) {
                var data = undoData.data;
                var model = undoData.model;

                _this.undoableCreate(model, data, function(newData) {
                  // Push a new deletion function onto the redo stack.
                  if (_this.undoManager) {
                    if (isRedoOfDelete) {
                      //  We just undid a delete, so this create will
                      //  override the ID parameter of previous undoable calls.
                      //  We need to replace ID parameters in the undo stack.
                      _this.undoManager.replaceIDs(model, data.id, newData.id);
                    } else {
                      var redoData = {
                        model: model,
                        data: newData,
                        id: newData.id,
                      };

                      _this.undoManager.addRedo(function(redoData) {
                        var model = redoData.model;
                        var data = redoData.data;
                        _this.undoableDelete(model, data, undefined, undefined, false, true);
                      }, redoData);
                    }
                  }
                }, undefined, true, false);
              }, undoData);
            }
          }

          return cb && cb(data);
        }, error || this.options.errorCallback, 'delete');
      };

      Socket.prototype.emit = function(eventName, data, callback) {
        return this.ioSocket.emit(eventName, data, asyncAngularify(this.ioSocket, callback));
      };

      // when socket.on('someEvent', fn (data) { ... }),
      // call scope.$broadcast('someEvent', data)
      Socket.prototype.forward = function(events, scope, shouldAddModelName) {
        if (events instanceof Array === false) {
          events = [events];
        }
        if (!scope) {
          scope = this.options.defaultScope;
        }
        angular.forEach(events, function(eventName) {
          var prefixedEvent = this.options.eventPrefix + eventName;
          var forwardBroadcast = asyncAngularify(this.ioSocket, function(data) {
            var key = prefixedEvent;
            if (shouldAddModelName) {
              key = prefixedEvent + ":" + data.model.toLowerCase();
            }
            scope.$broadcast(key, data);
          });
          scope.$on('$destroy', function() {
            this.ioSocket.removeListener(eventName, forwardBroadcast);
          }.bind(this));
          this.ioSocket.on(eventName, forwardBroadcast);
        }, this);
      };

      Socket.prototype.disconnect = function() {
        this.canReconnect = false;
        $timeout.cancel(this.disconnectRetryTimer);
        this.removeRetryListeners();
        this.ioSocket.disconnect();
      };

      Socket.prototype.connect = function(options) {
        if (this.ioSocket) this.disconnect();
        angular.extend(this.options, options);

        this.ioSocket = io.connect(this.options.url, {
          reconnect: false
        });
        this.forward(this.options.eventForwards);
        this.forward(this.options.modelEventForwards, null, true);
        this.canReconnect = true;
        this.addRetryListeners();
        return this;
      };

      //
      // Custom retry logic
      //
      Socket.prototype.addRetryListeners = function() {
        this.on('disconnect', this.onDisconnect);
        this.on('error', this.onError);
        this.on('connect', this.onConnect);
      };

      Socket.prototype.removeRetryListeners = function() {
        this.off('disconnect', this.onDisconnect);
        this.off('error', this.onError);
        this.off('connect', this.onConnect);
      };

      Socket.prototype.onConnect = function() {
        $log.debug('socket::connected');
      };

      // *disconnect* occurs after a connection has been made.
      Socket.prototype.onDisconnect = function() {
        $log.warn('socket::disconnected');
        var attempts = 0;
        var retry = function() {
          if (!this.canReconnect) return;

          this.disconnectRetryTimer = $timeout(function() {
            // Make http request before socket connect, to ensure auth/session cookie
            $log.info('socket::retrying... ', attempts, this.options.url);
            $http.get(this.options.url)
              .success(function(data, status) {
                this.ioSocket.connect();
              }.bind(this))
              .error(function(data, status) {
                if (attempts < this.options.reconnectionAttempts) {
                  retry();
                } else {
                  // send failure event
                  $log.error('socket::failure');
                  $rootScope.$broadcast(this.options.eventPrefix + 'failure');
                }
              }.bind(this));
          }.bind(this), this.options.reconnectionDelay(attempts++));
        }.bind(this);

        if (attempts < this.options.reconnectionAttempts) retry();
      };

      // *error* occurs when the initial connection fails.
      Socket.prototype.onError = function() {
        $timeout(function() {
          $log.error('socket::failure');
          $rootScope.$broadcast(this.options.eventPrefix + 'failure');
        }, 0);
      };

      return function(options) {
        return new Socket(options);
      };
    }

  // setupTransceiver is to be called from controllers.
  ]).factory('setupTransceiver', [function() {
      "use strict";

      var pathToModel = function(path) {
        return inflection.singularize(inflection.camelize(path));
      };

      return function setupSocket(scope, data, transform, options) {
        if (!transform) throw new Error("Transform function must be passed to setupSocket.");

        if (typeof options === "undefined") {
          options = {};
        }

        if (!('isCollection' in options)) {
          options.isCollection = true;
        }

        var unBindFunctions = _.reduce(data, function(acc, value, key) {
          var modelName = pathToModel(key).toLowerCase();

          var functions = [];

          functions.push(scope.$on('socket:create:' + modelName, function(ev, created) {
            if (options.isCollection) {
              data[key][created.id] = created.data;
            } else {
              data[key] = created.data;
            }
            transform(data, 'create', key, created);
          }));
          functions.push(scope.$on('socket:enter:' + modelName, function(ev, entered) {
            if (options.isCollection) {
              data[key][entered.id] = entered.data;
            } else {
              data[key] = entered.data;
            }
            transform(data, 'enter', key, entered);
          }));
          functions.push(scope.$on('socket:update:' + modelName, function(ev, updated) {
            if (options.isCollection) {
              data[key][updated.id] = updated.data;
            } else {
              data[key] = updated.data;
            }
            transform(data, 'update', key, updated);
          }));
          functions.push(scope.$on('socket:exit:' + modelName, function(ev, exited) {
            if (options.isCollection) {
              delete data[key][exited.id];
            } else {
              delete data[key];
            }
            transform(data, 'exit', key, exited);
          }));
          functions.push(scope.$on('socket:destroy:' + modelName, function(ev, destroyed) {
            if (options.isCollection) {
              delete data[key][destroyed.id];
            } else {
              delete data[key];
            }
            transform(data, 'destroy', key, destroyed);
          }));

          return acc.concat(acc, functions);
        }, []);

        var unBind = function() {
          _.forEach(unBindFunctions, function(fn) { fn(); });
        };

        scope.$on("$destroy", unBind);

        transform(data);

        return unBind;
      };
    }
  ]);
