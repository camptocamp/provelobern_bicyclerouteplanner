goog.provide('app.SearchController');
goog.provide('app.searchDirective');

goog.require('app');
goog.require('ol.geom.Point');



/**
 * @constructor
 * @param {angular.Scope} $scope Scope.
 * @param {angular.JQLite} $element
 * @param {angularGettext.Catalog} gettextCatalog Gettext catalog.
 * @param {angularLocalStorage.localStorageService} localStorageService
 *        LocalStorage service.
 * @ngInject
 * @export
 */
app.SearchController = function($scope, $element, gettextCatalog,
    localStorageService) {

  /**
   * @type {angularGettext.Catalog}
   */
  this.gettextCatalog = gettextCatalog;

  /**
   * @type {!ol.Map}
   * @private
   */
  this.map_ = $scope['map'];

  /**
   * @type {number}
   * @private
   */
  this.limit_ = app.SearchController.LIMIT;

  /**
   * @private
   */
  this.favorites_ = new app.Favorites(localStorageService);

  /**
   * @type {Bloodhound}
   * @private
   */
  this.nominatim_ = new Bloodhound(/** @type {BloodhoundOptions} */({
    limit: this.limit_,
    queryTokenizer: Bloodhound.tokenizers.whitespace,
    datumTokenizer: Bloodhound.tokenizers.obj.whitespace('label'),
    remote: {
      url: 'http://nominatim.openstreetmap.org/search',
      rateLimitWait: 300,
      replace: function(url, query) {
        var coordinate = app.SearchController.matchCoordinate(query);
        if (coordinate !== null) {
          // swap lon/lat if it's a coordinate
          query = coordinate[1] + ',' + coordinate[0];
        }
        return url +
               '?q=' + encodeURIComponent(query) +
                '&format=jsonv2&polygon=0&addressdetails=1' +
                '&accept-language=' + gettextCatalog.currentLanguage +
                '&countrycodes=ch' +
                '&limit=' + app.SearchController.LIMIT;
      },
      filter: function(resp) {
        var datums = /** @type {Array.<BloodhoundDatum>} */ (resp);
        return datums.map(function(datum) {
          datum['label'] =
              app.SearchController.formatAddress(/** @type {Object} */
                  (datum['address']));

          return datum;
        });
      }
    }
  }));
  this.nominatim_.initialize();

  /**
   * @type {Bloodhound}
   * @private
   */
  this.favoritesSource_ = new Bloodhound(/** @type {BloodhoundOptions} */({
    queryTokenizer: Bloodhound.tokenizers.whitespace,
    datumTokenizer: Bloodhound.tokenizers.obj.whitespace('name'),
    local: goog.bind(function() {
      return this.favorites_.getFavorites();
    }, this)
  }));
  this.favoritesSource_.initialize();

  var view = this.map_.getView();

  $element.typeahead({
    highlight: true,
    minLength: 3
  }, {
    name: 'coordinates',
    displayKey: 'label',
    source: this.createSearchCoordinates_()
  }, {
    name: 'favorites',
    displayKey: 'label',
    source: goog.bind(function(query, cb) {
      this.favoritesSource_.clear();
      this.favoritesSource_.initialize(true);
      this.favoritesSource_.get(query, function(suggestions) {
        cb(suggestions);
      });
    }, this),
    templates: {
      'suggestion': function(favorite) {
        return '<p><span class="glyphicon glyphicon-star"' +
            ' aria-hidden="true"></span> ' +
            favorite['name'] + '<br>' + favorite['label'] +
            '</p>';
      }
    }
  }, {
    name: 'nominatim',
    displayKey: 'label',
    source: this.nominatim_.ttAdapter(),
    templates: {
      'empty': function() {
        return '<span class="tt-no-result"><p>' +
            gettextCatalog.getString('No address found') + '</p></span>';
      }
    }
  });

  $element.on('typeahead:selected', goog.bind(function(event, datum, dataset) {
    $(event.target).focus();
    var geometry = this.getGeometry_(datum);
    $scope['onSelect']({'location': geometry, 'item': datum});

    view.setCenter(geometry.getCoordinates());
    view.setZoom(15);
  }, this));

  $element.on('focusout', goog.bind(function(event) {
    // make sure that the current value is not lost on focusout
    var value = $element[0].value;
    if (value !== '') {
      $element.typeahead('val', value);
    }
  }, this));
};

app.module.controller('appSearchController', app.SearchController);


/**
 * @private
 * @return {function(string, function(Array.<number>))}
*/
app.SearchController.prototype.createSearchCoordinates_ = function() {
  return function(query, callback) {
    var suggestions = [];
    var coordinate = app.SearchController.matchCoordinate(query);
    if (coordinate !== null) {
      suggestions.push({
        'label': query,
        'lon': coordinate[0],
        'lat': coordinate[1]
      });
    }
    callback(suggestions);
  };
};


/**
 * @private
 * @param {BloodhoundDatum} datum
 * @return {ol.geom.Point}
*/
app.SearchController.prototype.getGeometry_ = function(datum) {
  if (!goog.isDef(datum['geometry'])) {
    datum['geometry'] = new ol.geom.Point(ol.proj.transform(
        [parseFloat(datum['lon']), parseFloat(datum['lat'])],
        'EPSG:4326', 'EPSG:3857'));
  }
  return /** @type {ol.geom.Point} */ (datum['geometry']);
};


/**
 * @return {angular.Directive} The directive specs.
 * @ngInject
 */
app.searchDirective = function() {
  return {
    restrict: 'A',
    scope: {
      'map': '=appMap',
      'onSelect': '&appSearchOnselect'
    },
    controller: 'appSearchController'
  };
};

app.module.directive('appSearch', app.searchDirective);


/**
 * @type {number}
 */
app.SearchController.LIMIT = 15;


/**
 * @param {string} query
 * @return {ol.Coordinate}
*/
app.SearchController.matchCoordinate = function(query) {
  var match = query.match(/([\d\.']+)[\s,\/]+([\d\.']+)/);
  if (match) {
    var left = parseFloat(match[1].replace("'", ''));
    var right = parseFloat(match[2].replace("'", ''));

    return [left, right];
  }
  return null;
};


/**
 * @param {Object} address
 * @return {string}
*/
app.SearchController.formatAddress = function(address) {
  // we are not using the provided `display_name` field because it is too
  // verbose. instead we build a custom label from the address details
  // ignoring some of the address fields.
  var blacklist = [
    'county', 'state_district', 'country', 'country_code'];

  var addressKeys = goog.object.getKeys(address);
  var addressDetails = [];
  goog.array.forEach(addressKeys, function(key) {
    if (!goog.array.contains(blacklist, key)) {
      addressDetails.push(address[key]);
    }
  });

  return addressDetails.join(', ');
};
